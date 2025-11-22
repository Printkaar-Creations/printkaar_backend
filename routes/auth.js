require("dotenv").config();
const express = require("express");
const router = express.Router();
const { body, validationResult } = require("express-validator");
const nodemailer = require("nodemailer");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const fetchAdmin = require("../middleware/fetchAdmin");

const JWT_SECRET = "PrintKArr";

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.SMTP_USER, // e.g. your gmail
    pass: process.env.SMTP_PASS,
  },
});


// ------------------ CREATE ADMIN ----------------------
router.post(
  "/createuser",
  [
    body("userName", "Enter a valid Name").isLength({ min: 3 }),
    body("email", "Enter a valid Email").isEmail(),
    body("password", "Password must be minimum 5 characters").isLength({ min: 5 }),
    body("pin", "PIN must be 6 digits").isLength({ min: 6, max: 6 }).optional(),
  ],
  async (req, res) => {
    let success = false;

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success, errors: errors.array() });
    }

    try {
      const { userName, email, password, pin } = req.body;

      let user = await User.findOne({ email });
      if (user) {
        return res.status(400).json({ success, error: "Email already exists" });
      }

      const salt = await bcrypt.genSalt(10);

      const hashedPassword = await bcrypt.hash(password, salt);
      const hashedPin = pin ? await bcrypt.hash(pin, salt) : null;

      user = await User.create({
        userName,
        email,
        password: hashedPassword,
        pin: hashedPin
      });

      const data = { user: { id: user.id, role: user.role } };

      const authToken = jwt.sign(data, JWT_SECRET);
      success = true;

      res.json({ success, authToken });
    } catch (error) {
      console.error(error);
      res.status(500).send("Internal Server Error");
    }
  }
);

router.post(
  "/set-pin",
  fetchAdmin,
  [body("pin", "PIN must be 6 digits").isLength({ min: 6, max: 6 })],
  async (req, res) => {
    try {
      const { pin } = req.body;

      const salt = await bcrypt.genSalt(10);
      const hashedPin = await bcrypt.hash(pin, salt);

      const updatedUser = await User.findByIdAndUpdate(
        req.user.id,
        { pin: hashedPin },
        { new: true }
      ).select("-password -pin");

      res.json({ success: true, message: "PIN set successfully", user: updatedUser });
    } catch (err) {
      console.error(err);
      res.status(500).send("Internal server error");
    }
  }
);

router.post(
  "/verify-pin",
  fetchAdmin,
  [
    body("pin", "PIN is required").isLength({ min: 6, max: 6 })
  ],
  async (req, res) => {
    try {
      const { pin } = req.body;

      const user = await User.findById(req.user.id);
      if (!user.pin) {
        return res.status(400).json({ error: "PIN not set. Please create one." });
      }

      const match = await bcrypt.compare(pin, user.pin);
      if (!match) {
        return res.status(400).json({ error: "Incorrect PIN" });
      }

      return res.json({ success: true, message: "PIN verified successfully" });
    } catch (error) {
      console.error(error);
      return res.status(500).send("Internal Server Error");
    }
  }
);


// ------------------ LOGIN ----------------------
router.post(
  "/login",
  [
    body("email", "Enter a valid Email").isEmail(),
    body("password", "Password cannot be empty").exists(),
  ],
  async (req, res) => {
    let success = false;

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success, errors: errors.array() });
    }

    const { email, password } = req.body;

    try {
      let user = await User.findOne({ email });
      if (!user) {
        return res.status(400).json({ error: "Invalid credentials" });
      }

      const passwordMatch = await bcrypt.compare(password, user.password);
      if (!passwordMatch) {
        return res.status(400).json({ error: "Invalid credentials" });
      }

      const data = { user: { id: user.id, role: user.role } };

      const authToken = jwt.sign(data, JWT_SECRET);
      success = true;

      return res.json({ success, authToken });
    } catch (error) {
      console.error(error);
      return res.status(500).send("Internal Server Error");
    }
  }
);


// ------------------ GET LOGGED-IN ADMIN ----------------------
router.post("/getuser", fetchAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("-password");
    return res.send(user);
  } catch (error) {
    console.error(error);
    return res.status(500).send("Internal Server Error");
  }
});


// ------------------ ADMIN CAN FETCH ALL USERS ----------------------
router.get("/getallusers", fetchAdmin, async (req, res) => {
  try {
    const users = await User.find().select("-password");
    return res.json(users);
  } catch (error) {
    console.error(error);
    return res.status(500).send("Internal Server Error");
  }
});

// ------------------ FORGOT PASSWORD (SEND OTP) ----------------------
router.post(
  "/forgot-password",
  [body("email", "Enter a valid Email").isEmail()],
  async (req, res) => {
    try {
      const { email } = req.body;

      const user = await User.findOne({ email });
      if (!user) {
        return res.status(400).json({ success: false, error: "User not found" });
      }

      // Generate 6-digit OTP
      const otp = Math.floor(100000 + Math.random() * 900000).toString();

      // Hash OTP before storing
      const salt = await bcrypt.genSalt(10);
      const hashedOtp = await bcrypt.hash(otp, salt);

      user.resetOtp = hashedOtp;
      user.resetOtpExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 min
      await user.save();

      // Send email
      await transporter.sendMail({
        from: process.env.SMTP_USER,
        to: user.email,
        subject: "Your Password Reset OTP",
        text: `Your OTP to reset password is: ${otp}\nThis OTP is valid for 10 minutes.`,
      });

      res.json({
        success: true,
        message: "OTP sent to your email address",
      });
    } catch (error) {
      console.error(error);
      res.status(500).send("Internal Server Error");
    }
  }
);

// ------------------ RESET PASSWORD USING OTP ----------------------
router.post(
  "/reset-password",
  [
    body("email", "Enter a valid Email").isEmail(),
    body("otp", "OTP is required").isLength({ min: 6, max: 6 }),
    body("newPassword", "Password must be at least 5 chars").isLength({ min: 5 }),
  ],
  async (req, res) => {
    try {
      const { email, otp, newPassword } = req.body;

      const user = await User.findOne({ email });
      if (!user || !user.resetOtp) {
        return res.status(400).json({ success: false, error: "Invalid request" });
      }

      if (!user.resetOtpExpires || user.resetOtpExpires < new Date()) {
        return res.status(400).json({ success: false, error: "OTP expired" });
      }

      const isMatch = await bcrypt.compare(otp, user.resetOtp);
      if (!isMatch) {
        return res.status(400).json({ success: false, error: "Invalid OTP" });
      }

      // OTP correct → update password
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(newPassword, salt);

      user.password = hashedPassword;
      user.resetOtp = null;
      user.resetOtpExpires = null;
      await user.save();

      res.json({ success: true, message: "Password reset successfully" });
    } catch (error) {
      console.error(error);
      res.status(500).send("Internal Server Error");
    }
  }
);

module.exports = router;