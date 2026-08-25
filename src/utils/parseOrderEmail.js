const { getServicesBySageCode } = require('../services');

/**
 * Analyse un email de commande réel, du type :
 *
 *   Bâtiment 1 (chambres 1, 2, 3) — env. 429.21 € HT :
 *   Article                    Réf.     Qté
 *   Housse de couette 2p       B-HC2    10
 *   Drap plat 2p                B-DP2    24
 *
 *   Bâtiment 2 (chambres 30, 31) — env. 106.72 € HT :
 *   ...
 *
 * Reconnaît les codes Sage réels (avec préfixe, ex. B-HC2), regroupe par
 * bâtiment (un bâtiment = une commande séparée), et cumule les quantités
 * si un même code apparaît plusieurs fois dans un bâtiment (ex. "Taie
 * rectangle" et "Taie carrée" partagent souvent le même code B-Taie).
 *
 * Si aucun "Bâtiment" n'est détecté, tout l'email est traité comme un
 * bâtiment unique sans nom — pour rester compatible avec un hôtel qui
 * envoie une liste simple, sans découpage.
 *
 * Le catalogue (donc les codes reconnus) est relu à chaque appel, pas
 * figé au démarrage — un article ajouté depuis Administration → Gestion
 * des articles est immédiatement reconnaissable dans les emails suivants.
 *
 * Retourne { ok, buildings: [{ label, rooms, items }], livraisonPrevue, errors }.
 */
function parseOrderEmail(text) {
  const servicesBySageCode = getServicesBySageCode();
  const codesSorted = Object.keys(servicesBySageCode).sort((a, b) => b.length - a.length);

  if (codesSorted.length === 0) {
    return { ok: false, errors: ['Aucun article dans le catalogue — impossible de reconnaître quoi que ce soit.'], buildings: [], livraisonPrevue: null };
  }

  const codePattern = new RegExp(
    '(?:^|[\\s])(' + codesSorted.map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')(?:[\\s]|$)',
    'i'
  );

  const raw = text || '';

  // Date de livraison : premier motif JJ/MM/AAAA rencontré dans le mail.
  const dateMatch = raw.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  const livraisonPrevue = dateMatch ? `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}` : null;

  // Tout ce qui suit "Récapitulatif" est un résumé de contrôle lisible par
  // un humain, pas des données à extraire — on arrête l'analyse avant,
  // pour éviter de confondre ses lignes ("Bâtiment 1 : 22 départ(s)...")
  // avec de vrais en-têtes de bâtiment.
  const recapIndex = raw.search(/^\s*R[ée]capitulatif\b/im);
  const usableText = recapIndex === -1 ? raw : raw.slice(0, recapIndex);

  const lines = usableText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  const buildings = [];
  let current = null;

  function pushCurrent() {
    if (current) buildings.push(current);
  }

  for (const line of lines) {
    const buildingHeader = line.match(/^B[âa]timent\s+(\S+)/i);
    if (buildingHeader) {
      pushCurrent();
      const roomsMatch = line.match(/chambres?\s*([\d,\s]+)\)/i);
      current = {
        label: `Bâtiment ${buildingHeader[1]}`,
        rooms: roomsMatch ? roomsMatch[1].split(',').map(s => s.trim()).filter(Boolean) : [],
        itemsByService: {},
      };
      continue;
    }

    const codeMatch = line.match(codePattern);
    if (!codeMatch) continue;

    if (!current) current = { label: '', rooms: [], itemsByService: {} };

    const svc = servicesBySageCode[codeMatch[1].toUpperCase()];
    if (!svc) continue;

    // La quantité est le dernier nombre entier de la ligne (généralement
    // en fin de tableau) ; les chiffres dans le nom de l'article ("2p")
    // ou dans le code lui-même sont ignorés puisqu'on prend le dernier.
    const numbers = line.match(/\d+/g) || [];
    const qty = numbers.length ? parseInt(numbers[numbers.length - 1], 10) : 0;
    if (!Number.isInteger(qty) || qty <= 0) continue;

    if (!current.itemsByService[svc.id]) {
      current.itemsByService[svc.id] = { id: svc.id, name: svc.name, code: svc.code, sageCode: svc.sageCode, price: svc.price, qty: 0 };
    }
    current.itemsByService[svc.id].qty += qty;
  }
  pushCurrent();

  const result = buildings
    .map(b => ({ label: b.label, rooms: b.rooms, items: Object.values(b.itemsByService) }))
    .filter(b => b.items.length > 0);

  if (result.length === 0) {
    return {
      ok: false,
      errors: ["Aucun article reconnu — vérifiez que les codes utilisés (ex. B-HC2) existent bien dans le catalogue."],
      buildings: [],
      livraisonPrevue,
    };
  }
  return { ok: true, buildings: result, livraisonPrevue };
}

module.exports = { parseOrderEmail };
