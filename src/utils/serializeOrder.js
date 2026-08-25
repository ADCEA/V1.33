// Format de sortie unique pour une commande, utilisé par toutes les routes
// (clients, orders, admin) afin que le frontend reçoive toujours la même forme.
function serializeOrder(order, items) {
  return {
    id: order.id,
    ticket: order.ticket,
    status: order.status,
    productionStage: order.production_stage,
    driverId: order.driver_id,
    deliverySequence: order.delivery_sequence,
    client: {
      societe: order.societe,
      contact: order.contact,
      tel: order.tel,
      adresse: order.adresse,
    },
    livraisonPrevue: order.livraison_prevue,
    notes: order.notes,
    createdAt: order.created_at,
    items: items || [],
  };
}

module.exports = { serializeOrder };
