// require("dotenv").config();
const connectToMongo = require("./db");
connectToMongo();
const express = require("express");
const cors = require("cors");
// Allow all origins (not recommended for production)

// Connect to MongoDB
const app = express();
const PORT = process.env.PORT || 8000;

// Middleware
app.use(cors({ origin: "*" }));
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// Available routes
app.use("/api/auth", require("./routes/auth"));
app.use("/api/entry", require("./routes/entry"));

app.get("/", (req, res) => {
  res.json({ message: "Hello MERN Stack! " });
});

// Start server
app.listen(PORT, () => {
  console.log(`Sadaqah backend listening on port ${PORT}`);
});