const db = require('../db');
const { isOdooConfigured, checkOdooInvoiceState } = require('./odoo');

// États Odoo qui doivent déclencher la libération des BL rattachés :
// annulée explicitement ("cancel"), OU la facture n'existe plus DU TOUT
// dans Odoo (supprimée — une lecture sur un id inexistant renvoie un
// résultat vide, donc `null` via checkOdooInvoiceState). Dans les deux
// cas, du point de vue de notre système, ces BL ne sont plus facturés.
function shouldRelease(odooState) {
  return odooState === 'cancel' || odooState === null;
}

/**
 * Vérifie UNE facture et libère ses BL rattachés si nécessaire (voir
 * shouldRelease). Utilisée à la fois par le bouton manuel "Vérifier le
 * statut" et par la vérification automatique périodique ci-dessous — une
 * seule implémentation, pour ne jamais laisser les deux diverger.
 */
async function checkAndReleaseIfNeeded(invoice) {
  const odooState = await checkOdooInvoiceState(invoice.odoo_move_id);
  if (!shouldRelease(odooState)) {
    return { released: false, odooState };
  }
  const release = db.transaction(() => {
    db.prepare('DELETE FROM invoice_orders WHERE invoice_id = ?').run(invoice.id);
    db.prepare("UPDATE invoices SET status = 'cancelled', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), invoice.id);
  });
  release();
  return { released: true, odooState };
}

// Intervalle de vérification automatique en arrière-plan. PAS "toutes
// les secondes" comme envisagé initialement : à ce rythme (86 400
// vérifications/jour et par facture en attente), le volume de requêtes
// vers Odoo serait disproportionné par rapport au besoin réel — une
// facture ne change pas de statut à la seconde près, et un tel volume
// risquerait de déclencher une limitation de débit côté Odoo. 5 minutes
// détecte une annulation largement assez vite pour un usage de
// facturation, sans solliciter l'API inutilement.
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
let isChecking = false;

/**
 * Vérifie toutes les factures encore actives localement (pas déjà
 * marquées "cancelled") qui ont un id Odoo à contrôler. Une erreur sur
 * une facture précise (réseau, id invalide...) est journalisée mais
 * n'interrompt jamais la vérification des autres.
 */
async function checkAllPendingInvoices() {
  if (!isOdooConfigured() || isChecking) return;
  isChecking = true;
  try {
    const pending = db.prepare(`
      SELECT id, odoo_move_id FROM invoices
      WHERE status != 'cancelled' AND odoo_move_id IS NOT NULL
    `).all();
    for (const invoice of pending) {
      try {
        const { released, odooState } = await checkAndReleaseIfNeeded(invoice);
        if (released) {
          console.log(`Facture #${invoice.id} détectée ${odooState === null ? 'supprimée' : 'annulée'} dans Odoo — BL libérés automatiquement.`);
        }
      } catch (err) {
        console.error(`Vérification automatique du statut de la facture #${invoice.id} échouée :`, err.message);
      }
    }
  } finally {
    isChecking = false;
  }
}

/**
 * Démarre la vérification périodique — à appeler UNE FOIS au lancement
 * du serveur (voir server.js). N'échoue jamais bruyamment si Odoo n'est
 * pas configuré : checkAllPendingInvoices se contente de ne rien faire
 * dans ce cas, à chaque intervalle.
 */
function startInvoiceStatusScheduler() {
  setInterval(checkAllPendingInvoices, CHECK_INTERVAL_MS);
}

module.exports = { shouldRelease, checkAndReleaseIfNeeded, checkAllPendingInvoices, startInvoiceStatusScheduler };
