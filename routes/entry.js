const express = require("express");
const router = express.Router();
const Entry = require("../models/Entry");
const Balance = require("../models/Balance");
const fetchAdmin = require("../middleware/fetchAdmin");
const { body, validationResult } = require("express-validator");
const handleProfitLoss = require("../helper/handleProfitLoss");

// ------------------ ADD ENTRY ------------------

router.post(
  "/add",
  fetchAdmin,
  [
    body("type").isIn(["sell", "purchase", "others", "expense", "restMoney"]),
    body("totalAmount").isNumeric(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      let entryData = req.body;

      // PURCHASE must be linked
      if (entryData.type === "purchase" && !entryData.linkedSellId) {
        return res.status(400).json({
          error: "Purchase must link to a Sell entry.",
        });
      }

      // restMoney must be linked
      if (entryData.type === "restMoney" && !entryData.linkedSellId) {
        return res.status(400).json({
          error: "restMoney must link to a Sell entry.",
        });
      }

      // Validate linked sell
      let relatedSell = null;
      if (entryData.linkedSellId) {
        relatedSell = await Entry.findById(entryData.linkedSellId);
        if (!relatedSell || relatedSell.type !== "sell") {
          return res.status(400).json({
            error: "Invalid linkedSellId: SELL entry not found.",
          });
        }
      }

      // -------------------- HANDLE REST MONEY --------------------
      if (entryData.type === "restMoney") {
        const sellEntry = relatedSell;

        const updatedRest =
          Number(sellEntry.restMoney || 0) + Number(entryData.restMoney);

        const advance = Number(sellEntry.advance || 0);
        const total = Number(sellEntry.totalAmount || 0);

        const newAction =
          advance + updatedRest === total ? "completed" : "processing";

        // Update SELL entry
        await Entry.findByIdAndUpdate(entryData.linkedSellId, {
          $set: {
            restMoney: updatedRest,
            action: newAction,
          },
        });

        // SELL becomes completed → calculate profit/loss
        if (newAction === "completed") {
          await handleProfitLoss(entryData.linkedSellId);
        }
      }

      // -------------------- HANDLE OTHERS / EXPENSE --------------------
      if (entryData.type === "others" || entryData.type === "expense") {
        let balance = await Balance.findOne();
        if (!balance) balance = await Balance.create({ amount: 0 });

        balance.amount -= Number(entryData.totalAmount || 0);
        await balance.save();
      }

      // -------------------- ACTION CALCULATION --------------------
      let actionStatus = "completed"; // default for all except SELL

      if (entryData.type === "sell") {
        const total = Number(entryData.totalAmount || 0);
        const advance = Number(entryData.advance || 0);
        const rest = Number(entryData.restMoney || 0);

        actionStatus = advance + rest === total ? "completed" : "processing";
      }

      // CREATE ENTRY
      const entry = await Entry.create({
        ...entryData,
        createdBy: req.user.id,
        action: actionStatus,
        status: "pending",
      });

      res.json({ success: true, entry });
    } catch (err) {
      console.log(err);
      res.status(500).send("Internal server error");
    }
  }
);

// ------------------ EDIT / UPDATE ENTRY ------------------
router.put("/edit/:id", fetchAdmin, async (req, res) => {
  try {
    const entryId = req.params.id;
    const updateData = req.body;

    const entry = await Entry.findById(entryId);
    if (!entry) return res.status(404).json({ error: "Entry not found" });

    // Only creator can edit
    if (String(entry.createdBy) !== String(req.user.id)) {
      return res
        .status(403)
        .json({ error: "Only creator can edit this entry" });
    }

    let oldTotalAmount = Number(entry.totalAmount || 0);
    let newTotalAmount = Number(updateData.totalAmount || oldTotalAmount);

    // 1️⃣ HANDLE OTHERS / EXPENSE EDIT
    if (entry.type === "others" || entry.type === "expense") {
      let balance = await Balance.findOne();
      if (!balance) balance = await Balance.create({ amount: 0 });

      // if total changed, adjust balance
      const diff = newTotalAmount - oldTotalAmount;
      balance.amount -= diff;
      await balance.save();
    }

    // 2️⃣ HANDLE restMoney EDIT (must update SELL entry)
    if (entry.type === "restMoney") {
      const sellEntry = await Entry.findById(entry.linkedSellId);

      const oldRestMoney = Number(entry.restMoney || 0);
      const newRestMoney = Number(updateData.restMoney || oldRestMoney);

      const diff = newRestMoney - oldRestMoney;

      const updatedRest = Number(sellEntry.restMoney || 0) + diff;

      const advance = Number(sellEntry.advance || 0);
      const total = Number(sellEntry.totalAmount || 0);

      const newAction =
        advance + updatedRest === total ? "completed" : "processing";

      await Entry.findByIdAndUpdate(entry.linkedSellId, {
        $set: {
          restMoney: updatedRest,
          action: newAction,
        },
      });

      // IF SELL BECAME COMPLETED → PROFIT/LOSS
      if (newAction === "completed") {
        await handleProfitLoss(entry.linkedSellId);
      }
    }

    // 3️⃣ HANDLE SELL EDIT (recalculate action + profit/loss)
    if (entry.type === "sell") {
      const total = Number(updateData.totalAmount ?? entry.totalAmount ?? 0);
      const advance = Number(updateData.advance ?? entry.advance ?? 0);
      const rest = Number(entry.restMoney ?? 0);

      const newAction = advance + rest === total ? "completed" : "processing";

      updateData.action = newAction;

      // SELL just changed to completed
      if (entry.action !== "completed" && newAction === "completed") {
        await handleProfitLoss(entry._id);
      }

      // SELL changed from completed → processing
      if (entry.action === "completed" && newAction === "processing") {
        // REVERSE previous profit/loss
        let balance = await Balance.findOne();
        if (!balance) balance = await Balance.create({ amount: 0 });

        balance.amount -= Number(entry.profitOrLoss || 0);
        await balance.save();

        // reset profit
        updateData.profitOrLoss = 0;
        updateData.profitType = "neutral";
      }
    }

    // update status
    updateData.status = "pending";

    const updatedEntry = await Entry.findByIdAndUpdate(
      entryId,
      { $set: updateData },
      { new: true }
    );

    res.json({ success: true, updatedEntry });
  } catch (err) {
    console.error(err);
    res.status(500).send("Internal server error");
  }
});

// ------------------ GET ALL ENTRIES ------------------
router.get("/all", fetchAdmin, async (req, res) => {
  try {
    const entries = await Entry.find().sort({ createdAt: -1 });

    res.json(entries);
  } catch (err) {
    res.status(500).send("Internal server error");
  }
});

// ------------------ DELETE ENTRY ------------------
router.delete("/delete/:id", fetchAdmin, async (req, res) => {
  try {
    const entry = await Entry.findById(req.params.id);
    if (!entry) {
      return res.status(404).json({ success: false, error: "Entry not found" });
    }

    let balance = await Balance.findOne();
    if (!balance) balance = await Balance.create({ amount: 0 });

    // ----------------------------------------------
    // 1️⃣ DELETE others / expense → RESTORE BALANCE
    // ----------------------------------------------
    if (entry.type === "others" || entry.type === "expense") {
      balance.amount += Number(entry.totalAmount || 0);
      await balance.save();
    }

    // ----------------------------------------------
    // 2️⃣ DELETE restMoney entry → reverse SELL updates
    // ----------------------------------------------
    if (entry.type === "restMoney") {
      const sell = await Entry.findById(entry.linkedSellId);
      if (sell) {
        const newRest =
          Number(sell.restMoney || 0) - Number(entry.restMoney || 0);
        const advance = Number(sell.advance || 0);
        const total = Number(sell.totalAmount || 0);

        const newAction =
          advance + newRest === total ? "completed" : "processing";

        // update sell entry
        await Entry.findByIdAndUpdate(sell._id, {
          $set: {
            restMoney: newRest,
            action: newAction,
          },
        });

        // reverse profit/loss if sell loses completion
        if (sell.action === "completed" && newAction === "processing") {
          balance.amount -= Number(sell.profitOrLoss || 0);
          await balance.save();

          await Entry.findByIdAndUpdate(sell._id, {
            $set: { profitOrLoss: 0, profitType: "neutral" },
          });
        }
      }
    }

    // ----------------------------------------------
    // 3️⃣ DELETE SELL → cascade delete all children
    // ----------------------------------------------
    if (entry.type === "sell") {
      // reverse profit/loss if completed
      if (entry.action === "completed") {
        balance.amount -= Number(entry.profitOrLoss || 0);
        await balance.save();
      }

      // delete purchases linked to this sell
      await Entry.deleteMany({ linkedSellId: entry._id, type: "purchase" });

      // delete restMoney linked to this sell
      await Entry.deleteMany({ linkedSellId: entry._id, type: "restMoney" });
    }

    // ----------------------------------------------
    // 4️⃣ FINALLY DELETE ENTRY ITSELF
    // ----------------------------------------------
    await Entry.findByIdAndDelete(req.params.id);

    res.json({
      success: true,
      message: "Entry and its linked records deleted successfully",
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Internal server error");
  }
});

// ------------------ REVIEW ENTRY ------------------
router.post("/review/:id", fetchAdmin, async (req, res) => {
  try {
    const entryId = req.params.id;
    const { status, note } = req.body;

    if (!["correct", "incorrect"].includes(status)) {
      return res.status(400).json({ error: "Invalid status value" });
    }

    const entry = await Entry.findById(entryId);

    if (!entry) {
      return res.status(404).json({ error: "Entry not found" });
    }

    // Creator cannot review their own entry
    if (String(entry.createdBy) === String(req.user.id)) {
      return res.status(403).json({
        error: "You cannot review your own entry",
      });
    }

    const updated = await Entry.findByIdAndUpdate(
      entryId,
      {
        status,
        reviewNote: note || "",
        reviewedBy: req.user.id,
      },
      { new: true }
    );

    res.json({ success: true, updated });
  } catch (err) {
    console.error(err);
    res.status(500).send("Internal server error");
  }
});

router.get("/assigned-to-me", fetchAdmin, async (req, res) => {
  try {
    const entries = await Entry.find({
      createdBy: req.user.id,
      status: "incorrect",
    }).sort({ createdAt: -1 });

    res.json(entries);
  } catch (err) {
    console.error(err);
    res.status(500).send("Internal server error");
  }
});

router.get("/balance", fetchAdmin, async (req, res) => {
  let balance = await Balance.findOne();
  if (!balance) {
    balance = await Balance.create({ amount: 0 });
  }
  res.json(balance);
});

// ------------------ DASHBOARD STATS ------------------
router.get("/stats", fetchAdmin, async (req, res) => {
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    // Fetch all entries
    const entries = await Entry.find();

    // Fetch today entries
    const todayEntries = await Entry.find({
      createdAt: { $gte: todayStart, $lte: todayEnd },
    });

    // Sale Total
    const saleTotal = entries
      .filter((e) => e.type === "sell")
      .reduce((sum, e) => sum + Number(e.totalAmount || 0), 0);

    // Purchase Total
    const purchaseTotal = entries
      .filter((e) => e.type === "purchase")
      .reduce((sum, e) => sum + Number(e.totalAmount || 0), 0);

    // Others Total
    const othersTotal = entries
      .filter((e) => e.type === "others")
      .reduce((sum, e) => sum + Number(e.totalAmount || 0), 0);

    // Expenses Total
    const expenseTotal = entries
      .filter((e) => e.type === "expense")
      .reduce((sum, e) => sum + Number(e.totalAmount || 0), 0);

    // Profit Total
    const profitTotal = entries
      .filter((e) => e.profitType === "profit")
      .reduce((sum, e) => sum + Number(e.profitOrLoss || 0), 0);

    // Loss Total
    const lossTotal = entries
      .filter((e) => e.profitType === "loss")
      .reduce((sum, e) => sum + Number(e.profitOrLoss || 0), 0);

    // Today Stats
    const todaySale = todayEntries
      .filter((e) => e.type === "sell")
      .reduce((sum, e) => sum + Number(e.totalAmount || 0), 0);

    const todayPurchase = todayEntries
      .filter((e) => e.type === "purchase")
      .reduce((sum, e) => sum + Number(e.totalAmount || 0), 0);

    const todayExpense = todayEntries
      .filter((e) => e.type === "expense")
      .reduce((sum, e) => sum + Number(e.totalAmount || 0), 0);

    const todayOthers = todayEntries
      .filter((e) => e.type === "others")
      .reduce((sum, e) => sum + Number(e.totalAmount || 0), 0);

    const todayProfit = todayEntries
      .filter((e) => e.profitType === "profit")
      .reduce((sum, e) => sum + Number(e.profitOrLoss || 0), 0);

    const todayLoss = todayEntries
      .filter((e) => e.profitType === "loss")
      .reduce((sum, e) => sum + Number(e.profitOrLoss || 0), 0);

    // Balance
    let balance = await Balance.findOne();
    if (!balance) balance = await Balance.create({ amount: 0 });

    res.json({
      success: true,
      totals: {
        saleTotal,
        purchaseTotal,
        expenseTotal,
        othersTotal,
        profitTotal,
        lossTotal,
        balance: balance.amount,
      },
      today: {
        todaySale,
        todayPurchase,
        todayExpense,
        todayOthers,
        todayProfit,
        todayLoss,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Internal server error");
  }
});

// ------------------ GET ALL SELL ENTRIES ------------------
router.get("/get-sell", fetchAdmin, async (req, res) => {
  try {
    const sells = await Entry.find({ type: "sell" })
      .sort({ createdAt: -1 })
      .select("name company totalAmount _id");

    return res.json({ success: true, sells });
  } catch (err) {
    console.error(err);
    res.status(500).send("Internal server error");
  }
});

// ------------------ GET SINGLE ENTRY ------------------
router.get("/:id", fetchAdmin, async (req, res) => {
  try {
    const entry = await Entry.findById(req.params.id);
    if (!entry) {
      return res.status(404).json({ success: false, error: "Entry not found" });
    }

    res.json({ success: true, entry });
  } catch (err) {
    console.error(err);
    res.status(500).send("Internal server error");
  }
});

// ------------------ GET REST MONEY BY SELL ID ------------------
router.get("/restmoney/:sellId", fetchAdmin, async (req, res) => {
  try {
    const restEntries = await Entry.find({
      type: "restMoney",
      linkedSellId: req.params.sellId,
    });

    res.json({ success: true, restMoney: restEntries });
  } catch (err) {
    console.error(err);
    res.status(500).send("Internal server error");
  }
});

module.exports = router;
