var jwt = require("jsonwebtoken");
const JWT_SECRET = "PrintKArr";

module.exports = function fetchAdmin(req, res, next) {
  const token = req.header("auth-token");
  if (!token) {
    return res.status(401).send({ error: "Token missing" });
  }

  try {
    const data = jwt.verify(token, JWT_SECRET);
    req.user = data.user;

    if (req.user.role !== "admin") {
      return res.status(403).send({ error: "Access Denied: Admin Only" });
    }

    next();
  } catch (error) {
    return res.status(401).send({ error: "Invalid Token" });
  }
};