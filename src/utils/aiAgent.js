const Database = require('better-sqlite3');
const { DB_PATH } = require('../db');

// Connexion SÉPARÉE, ouverte en LECTURE SEULE (readonly: true) — une
// garantie au niveau de SQLite lui-même, pas seulement une vérification
// de texte sur la requête. Même si l'IA générait une requête d'écriture
// malgré les instructions, SQLite la refuserait avant même de l'exécuter.
// Jamais la connexion principale (db.js, lecture/écriture) n'est utilisée
// ici.
const readonlyDb = new Database(DB_PATH, { readonly: true, fileMustExist: true });

// Résumé du schéma utile pour le reporting — pas toutes les tables (les
// jetons API, sessions, réglages internes n'ont pas leur place dans des
// questions métier), seulement celles qui répondent à des questions du
// type "combien", "quel chiffre d'affaires", "quelle satisfaction".
const SCHEMA_CONTEXT = `
Tables disponibles (SQLite) :

orders(id, ticket, client_id, societe, status['recue'|'traitement'|'prete'|'livree'],
  livraison_prevue TEXT date AAAA-MM-JJ, created_at TEXT datetime, notes)

order_items(id, order_id, name, code, sage_code, price REAL prix_unitaire_HT,
  qty INTEGER quantite_commandee, delivered_qty INTEGER quantite_reellement_livree,
  production_stage)
  -- Le CHIFFRE D'AFFAIRES / poids livré doit TOUJOURS utiliser delivered_qty
  -- (COALESCE(delivered_qty, qty)), jamais qty seule, sauf si la question
  -- porte explicitement sur ce qui a été COMMANDÉ plutôt que livré.

clients(id, societe, contact, tel, adresse, email, created_at,
  invoice_detail_level, siret, tva_number)

articles(id, name, code, sage_code, price REAL prix_catalogue, category,
  weight_g, odoo_product_id)

client_prices(id, client_id, article_id, price REAL tarif_negocie,
  date_debut, date_fin) -- date_fin NULL = tarif actif

nps_responses(id, client_id, score INTEGER 0_a_10, comment, created_at)
  -- promoteurs = score 9-10, passifs = 7-8, detracteurs = 0-6
  -- NPS = (%promoteurs - %detracteurs), en points de pourcentage

invoices(id, client_id, odoo_move_id, period_start, period_end, status,
  odoo_number, total_ht REAL, created_at)

invoice_orders(invoice_id, order_id) -- jonction : quel BL sur quelle facture

drivers(id, name, vehicle)
truck_maintenance(id, truck_type_id, date, type, mileage_km, cost, notes)
`.trim();

function buildSystemPrompt() {
  const today = new Date().toISOString().slice(0, 10);
  return `Tu es l'assistant de reporting interne de Blanchisserie Cézanne, une entreprise de blanchisserie professionnelle en Provence (Vaucluse) qui sert des hôtels clients.

Un responsable de l'entreprise te pose des questions en langage courant sur l'activité (commandes, chiffre d'affaires, satisfaction client, poids livré, etc.). Réponds en français, de façon concise et directe, avec les chiffres exacts.

RÈGLES IMPORTANTES :
- Utilise TOUJOURS l'outil run_sql_query pour obtenir les vrais chiffres avant de répondre — ne devine JAMAIS une valeur numérique. Si une question nécessite plusieurs requêtes (ex. comparer deux périodes), fais-les toutes avant de répondre.
- Base de données SQLite en lecture seule : SELECT uniquement.
- Devise : euros (€). Les prix dans order_items/articles/client_prices sont HT (hors taxe).
- Date du jour : ${today}. Pour "ce mois-ci", "la semaine dernière", etc., calcule les bornes de dates toi-même à partir de cette date.
- Pour le chiffre d'affaires ou les quantités livrées, utilise delivered_qty (avec COALESCE(delivered_qty, qty) au cas où elle serait NULL) — pas qty, sauf si la question porte explicitement sur les quantités commandées.
- Si une question est ambiguë (ex. "le mois dernier" sans préciser calendaire ou glissant), fais une hypothèse raisonnable, indique-la brièvement, et réponds quand même.
- Réponse synthétique : va à l'essentiel, pas de longue liste de requêtes ou de commentaire technique — juste la réponse business, avec les chiffres qui la soutiennent.

${SCHEMA_CONTEXT}`;
}

const SQL_TOOL = {
  name: 'run_sql_query',
  description: 'Exécute une requête SQL SELECT en lecture seule sur la base de données de l\'entreprise et renvoie les lignes de résultat (JSON). Aucune écriture possible — la connexion est strictement en lecture seule.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Requête SQL SELECT à exécuter (SQLite).' },
    },
    required: ['query'],
  },
};

// Vérification textuelle en COMPLÉMENT de la connexion readonly (défense
// en profondeur) — rejette explicitement toute requête qui ne commence
// pas par SELECT, avant même de la transmettre à SQLite.
function runReadOnlyQuery(query) {
  const trimmed = query.trim().replace(/;+\s*$/, '');
  if (!/^select\b/i.test(trimmed)) {
    throw new Error('Seules les requêtes SELECT sont autorisées.');
  }
  const rows = readonlyDb.prepare(trimmed).all();
  // Limite défensive : évite de renvoyer un résultat massif qui gonflerait
  // inutilement le coût/contexte si une requête mal bornée était générée.
  return rows.length > 500 ? { rows: rows.slice(0, 500), truncated: true, totalRows: rows.length } : rows;
}

/**
 * Répond à une question métier en langage naturel, en s'appuyant sur des
 * requêtes SQL réelles (jamais des chiffres devinés). Boucle agentique
 * bornée (8 tours max) pour éviter un enchaînement infini d'appels.
 */
async function answerBusinessQuestion(question) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("Agent IA non configuré (variable ANTHROPIC_API_KEY absente sur le serveur).");
  }

  const messages = [{ role: 'user', content: question }];
  const MAX_TURNS = 8;

  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1500,
        system: buildSystemPrompt(),
        tools: [SQL_TOOL],
        messages,
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(`Appel à l'API Claude échoué (${res.status}) : ${data?.error?.message || 'erreur inconnue'}`);
    }

    messages.push({ role: 'assistant', content: data.content });

    const toolUses = data.content.filter(b => b.type === 'tool_use');
    if (toolUses.length === 0) {
      return data.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim()
        || "Je n'ai pas pu formuler de réponse à partir des données disponibles.";
    }

    const toolResults = toolUses.map(tu => {
      let content;
      try {
        content = JSON.stringify(runReadOnlyQuery(tu.input.query));
      } catch (err) {
        content = `Erreur : ${err.message}`;
      }
      return { type: 'tool_result', tool_use_id: tu.id, content };
    });
    messages.push({ role: 'user', content: toolResults });
  }

  return "La question demande trop d'étapes pour être traitée d'un coup — essayez de la reformuler plus précisément.";
}

module.exports = { answerBusinessQuestion };
