const mongoose = require("mongoose");
const { Schema } = mongoose;

const EntrySchema = new Schema({
  type: {
    type: String,
    enum: ["sell", "purchase", "others", "expense", "restMoney","delivery"],
    required: true,
  },

  orderId: { type: String, unique: true },
  name: String,
  company: String,
  phone: String,
  note: String,
  address: String,

  totalAmount: Number,
  advance: { type: Number, default: 0 },
  restMoney: { type: Number, default: 0 }, // NEW

  gstIncluded: Boolean,
  hasDelivery: Boolean,
  deliveryCharge: Number,

  linkedSellId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Entry",
    default: null,
  },

  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },

  action: {
    type: String,
    enum: ["processing", "completed"],
    default: "completed",
  },

  status: {
    type: String,
    enum: ["pending", "correct", "incorrect"],
    default: "pending",
  },

  reviewedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    default: null,
  },
  reviewNote: { type: String, default: "" },

  createdAt: { type: Date, default: Date.now },
  profitOrLoss: { type: Number, default: 0 },
  profitType: {
    type: String,
    enum: ["profit", "loss", "neutral"],
    default: "neutral",
  },
});


// --------------------- AUTO ORDER ID GENERATOR ---------------------
// EntrySchema.pre("save", async function (next) {
//   if (this.orderId) return next();

//   try {
//     const lastEntry = await this.constructor.findOne().sort({ createdAt: -1 });

//     let nextNumber = 1;

//     if (lastEntry && lastEntry.orderId) {
//       const num = parseInt(lastEntry.orderId.replace(/\D/g, ""), 10);
//       nextNumber = num + 1;
//     }

//     const padded = String(nextNumber).padStart(6, "0");
//     this.orderId = `#P${padded}K`;

//     next();
//   } catch (err) {
//     next(err);
//   }
// });

module.exports = mongoose.model("Entry", EntrySchema);
