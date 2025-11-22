const mongoose = require("mongoose");
const { Schema } = mongoose;

const UserSchema = new Schema({
  role: { type: String, default: "admin" }, // admin by default
  userName: { type: String, required: true }, // FIXED: must match your route
  email: { type: String, required: true, unique: true },
  password: { type: String },
  pin: {
    type: String, // store hashed pin
    default: null,
  },
    // 🔹 FORGOT PASSWORD OTP
  resetOtp: { type: String, default: null },
  resetOtpExpires: { type: Date, default: null },
  date: { type: Date, default: Date.now },
});

module.exports = mongoose.model("User", UserSchema);
