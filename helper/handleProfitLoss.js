const Entry = require("../models/Entry");
const Balance = require("../models/Balance");

async function handleProfitLoss(sellId) {
  const sellEntry = await Entry.findById(sellId);
  if (!sellEntry) return;

  const sellTotal = Number(sellEntry.totalAmount || 0);

  // get all purchases linked to this sell
  const purchases = await Entry.find({
    linkedSellId: sellId,
    type: "purchase",
  });

  let purchaseTotal = 0;
  purchases.forEach((p) => {
    purchaseTotal += Number(p.totalAmount || 0);
  });

  const profitLoss = sellTotal - purchaseTotal;

  let type = "neutral";
  if (profitLoss > 0) type = "profit";
  if (profitLoss < 0) type = "loss";

  // update sell entry with profit/loss
  await Entry.findByIdAndUpdate(sellId, {
    $set: {
      profitOrLoss: profitLoss,
      profitType: type,
    },
  });

  // update balance
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
