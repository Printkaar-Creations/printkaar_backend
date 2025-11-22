const Entry = require("../models/Entry");
const Balance = require("../models/Balance");

async function handleProfitLoss(sellId) {
  const sellEntry = await Entry.findById(sellId);
  if (!sellEntry) return;

  const sellTotal = Number(sellEntry.totalAmount || 0);

  // Get all purchases linked to this sell
  const purchases = await Entry.find({
    linkedSellId: sellId,
    type: "purchase",
  });

  let purchaseTotal = purchases.reduce(
    (sum, p) => sum + Number(p.totalAmount || 0),
    0
  );

  // ⭐ NEW — Get all delivery charges OWN
  const deliveryOwnEntries = await Entry.find({
    linkedSellId: sellId,
    type: "delivery",
    note: "Delivery Charge (Own)",
  });

  const deliveryOwnTotal = deliveryOwnEntries.reduce(
    (sum, d) => sum + Number(d.totalAmount || 0),
    0
  );

  // ⭐ Calculate final profit
  const profitLoss = sellTotal - purchaseTotal - deliveryOwnTotal;

  let type = "neutral";
  if (profitLoss > 0) type = "profit";
  if (profitLoss < 0) type = "loss";

  // Update SELL entry
  await Entry.findByIdAndUpdate(sellId, {
    $set: {
      profitOrLoss: profitLoss,
      profitType: type,
    },
  });

  // Update balance (profit adds, loss subtracts)
  let balance = await Balance.findOne();
  if (!balance) balance = await Balance.create({ amount: 0 });

  balance.amount += profitLoss;
  await balance.save();

  return {
    profitLoss,
    profitType: type,
    updatedBalance: balance.amount,
  };
}

module.exports = handleProfitLoss;