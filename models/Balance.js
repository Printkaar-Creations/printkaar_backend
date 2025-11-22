const mongoose = require("mongoose");

const BalanceSchema = new mongoose.Schema({
  amount: {
    type: Number,
    default: 0
  }
});

module.exports = mongoose.model("Balance", BalanceSchema);