const { PDFDocument } = require('pdf-lib');

// Fusionne plusieurs PDF (Buffers) en un seul document, dans l'ordre du
// tableau fourni. Utilisé pour le PDF consolidé de facture : synthèse
// globale, puis facture Odoo, puis annexe détaillée BL par BL.
//
// AVERTISSEMENT : cette fonction s'appuie sur l'API stable et bien
// documentée de pdf-lib (PDFDocument.load / copyPages / addPage / save),
// mais n'a pas pu être testée en exécution réelle dans cet environnement
// (accès npm indisponible au moment de l'écrire, y compris pour des
// paquets déjà utilisés ailleurs dans ce projet). Premier essai réel à
// faire avec vous.
async function mergePdfs(buffersInOrder) {
  const merged = await PDFDocument.create();
  for (const buf of buffersInOrder) {
    if (!buf) continue;
    const doc = await PDFDocument.load(buf);
    const pages = await merged.copyPages(doc, doc.getPageIndices());
    pages.forEach(p => merged.addPage(p));
  }
  const bytes = await merged.save();
  return Buffer.from(bytes);
}

module.exports = { mergePdfs };
