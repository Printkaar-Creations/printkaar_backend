const express = require("express");
const router = express.Router();
const Entry = require("../models/Entry");
const Balance = require("../models/Balance");
const fetchAdmin = require("../middleware/fetchAdmin");
const { body, validationResult } = require("express-validator");
const handleProfitLoss = require("../helper/handleProfitLoss");

// ------------------ ADD ENTRY ------------------
async function generateMainOrderId() {
  // find last entry whose orderId is exactly "#P" + 6 digits
  const lastMain = await Entry.findOne({
    orderId: { $regex: /^#P\d{4}$/ },
  }).sort({ createdAt: -1 });

  if (!lastMain || !lastMain.orderId) {
    return "#P0001";
  }

  const lastNumber = parseInt(lastMain.orderId.slice(2, 8), 10); // extract 000001
  const newNumber = lastNumber + 1;

  return `#P${String(newNumber).padStart(6, "0")}`;
}

// Child IDs: for a given sell, generate #P000001A, #P000001B, ...
async function generateChildOrderId(sellId) {
  const sell = await Entry.findById(sellId);
  if (!sell || !sell.orderId) {
    // Fallback: if something is wrong, at least return a new main + A
    const base = await generateMainOrderId();
    return base + "A";
  }

  const base = sell.orderId; // e.g. "#P000001"

  // find all children that already use this base with a letter
  const children = await Entry.find({
    linkedSellId: sellId,
    orderId: { $regex: `^${base}[A-Z]$` },
  }).select("orderId");

  const usedLetters = new Set(children.map((c) => c.orderId.slice(-1)));

  let code = "A".charCodeAt(0);
  while (
    usedLetters.has(String.fromCharCode(code)) &&
    code <= "Z".charCodeAt(0)
  ) {
    code++;
  }

  const letter = String.fromCharCode(code); // "A", "B", ...
  return base + letter;
}

router.post(
  "/add",
  fetchAdmin,
  [
    body("type").isIn([
      "sell",
      "purchase",
      "others",
      "expense",
      "restMoney",
      "delivery",
    ]),
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
        return res
          .status(400)
          .json({ error: "Purchase must link to a Sell entry." });
      }

      // restMoney must be linked
      if (entryData.type === "restMoney" && !entryData.linkedSellId) {
        return res
          .status(400)
          .json({ error: "restMoney must link to a Sell entry." });
      }

      // Validate linked sell
      let relatedSell = null;
      if (entryData.linkedSellId) {
        relatedSell = await Entry.findById(entryData.linkedSellId);
        if (!relatedSell || relatedSell.type !== "sell") {
          return res
            .status(400)
            .json({ error: "Invalid linkedSellId: SELL entry not found." });
        }
      }

      // ==========================================================
      // DELIVERY CHARGE (SPECIAL CASE – DO NOT CREATE MAIN ENTRY)
      // ==========================================================
      if (entryData.type === "delivery") {
        const amount = Number(entryData.deliveryAmount);

        if (!amount || amount <= 0) {
          return res.status(400).json({ error: "Invalid delivery amount" });
        }

        // CUSTOMER PAYS → 2 ENTRIES
        if (entryData.deliveryType === "customer") {
          const orderId1 = await generateChildOrderId(entryData.linkedSellId);
          const orderId2 = await generateChildOrderId(entryData.linkedSellId);

          await Entry.create({
            type: "delivery",
            orderId: orderId1,
            name: relatedSell?.name,
            company: relatedSell?.company,
            totalAmount: amount,
            linkedSellId: entryData.linkedSellId,
            createdBy: req.user.id,
            note: "Delivery Charge (By Customer)",
            action: "completed",
          });

          await Entry.create({
            type: "delivery",
            orderId: orderId2,
            name: relatedSell?.name,
            company: relatedSell?.company,
            totalAmount: amount,
            linkedSellId: entryData.linkedSellId,
            createdBy: req.user.id,
            note: "Delivery Charge Paid",
            action: "completed",
          });
        }

        // OWN PAYS → 1 EXPENSE ENTRY
        if (entryData.deliveryType === "own") {
          let balance = await Balance.findOne();
          if (!balance) balance = await Balance.create({ amount: 0 });

          balance.amount -= amount;
          await balance.save();

          const childOrderId = await generateChildOrderId(
            entryData.linkedSellId
          );

          await Entry.create({
            type: "delivery",
            orderId: childOrderId,
            name: relatedSell?.name,
            company: relatedSell?.company,
            totalAmount: amount,
            linkedSellId: entryData.linkedSellId,
            createdBy: req.user.id,
            note: "Delivery Charge (Own)",
            action: "completed",
          });
          await handleProfitLoss(entryData.linkedSellId);
        }

        // STOP EXECUTION → NO MAIN ENTRY CREATION
        return res.json({ success: true, message: "Delivery charge added" });
      }

      // ==========================================================
      // REST MONEY
      // ==========================================================
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
          $set: { restMoney: updatedRest, action: newAction },
        });

        // MONEY IN → Add restMoney to balance
        let balance = await Balance.findOne();
        if (!balance) balance = await Balance.create({ amount: 0 });
        balance.amount += Number(entryData.restMoney || 0);
        await balance.save();

        // SELL becomes completed → calculate profit/loss
        if (newAction === "completed") {
          await handleProfitLoss(entryData.linkedSellId);
        }
      }

      // ==========================================================
      // OTHERS / EXPENSE
      // ==========================================================
      if (entryData.type === "others" || entryData.type === "expense") {
        let balance = await Balance.findOne();
        if (!balance) balance = await Balance.create({ amount: 0 });

        balance.amount -= Number(entryData.totalAmount || 0);
        await balance.save();
      }

      // ==========================================================
      // SELL → ADD ADVANCE TO BALANCE
      // ==========================================================
      if (entryData.type === "sell") {
        let balance = await Balance.findOne();
        if (!balance) balance = await Balance.create({ amount: 0 });

        const advance = Number(entryData.advance || 0);
        balance.amount += advance;
        await balance.save();
      }

        console.log(entryData, "entryData");
      // ==========================================================
      // PURCHASE → CUT FROM BALANCE
      // ==========================================================
      if (entryData.type === "purchase") {
        let balance = await Balance.findOne();
        if (!balance) balance = await Balance.create({ amount: 0 });

        const total = Number(entryData.totalAmount || 0);
        const delivery = Number(entryData.deliveryCharge || 0);

        // Deduct both
        balance.amount -= total + delivery;
        await balance.save();
      }

      // ==========================================================
      // ACTION CALCULATION FOR SELL
      // ==========================================================
      let actionStatus = "completed";

      if (entryData.type === "sell") {
        const total = Number(entryData.totalAmount || 0);
        const advance = Number(entryData.advance || 0);
        const rest = Number(entryData.restMoney || 0);

        actionStatus = advance + rest === total ? "completed" : "processing";
      }

      let orderId = null;
      // Main numbered IDs
      if (
        entryData.type === "sell" ||
        entryData.type === "others" ||
        entryData.type === "expense"
      ) {
        orderId = await generateMainOrderId();
      }

      // Child IDs under a sell
      if (entryData.type === "purchase" || entryData.type === "restMoney") {
        orderId = await generateChildOrderId(entryData.linkedSellId);
      }

      // ==========================================================
      // NORMAL ENTRY CREATION
      // ==========================================================
      const entry = await Entry.create({
        ...entryData,
        orderId,
        createdBy: req.user.id,
        action: actionStatus,
        status: "pending",
      });

      // If SELL is already fully paid at creation → compute profit
      if (entry.type === "sell" && entry.action === "completed") {
        await handleProfitLoss(entry._id);
      }

      return res.json({ success: true, entry });
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

    // 1️⃣ HANDLE OTHERS / EXPENSE EDIT  (adjust balance)
    if (entry.type === "others" || entry.type === "expense") {
      let balance = await Balance.findOne();
      if (!balance) balance = await Balance.create({ amount: 0 });

      const diff = newTotalAmount - oldTotalAmount;
      balance.amount -= diff;
      await balance.save();
    }

    // 2️⃣ HANDLE PURCHASE EDIT (adjust balance)
    if (entry.type === "purchase") {
      let balance = await Balance.findOne();
      if (!balance) balance = await Balance.create({ amount: 0 });

      const oldTotal =
        Number(entry.totalAmount || 0) + Number(entry.deliveryCharge || 0);
      const newTotal =
        Number(updateData.totalAmount ?? entry.totalAmount ?? 0) +
        Number(updateData.deliveryCharge ?? entry.deliveryCharge ?? 0);

      const diff = newTotal - oldTotal;
      balance.amount -= diff;
      await balance.save();
    }

    // 3️⃣ HANDLE restMoney EDIT (must update SELL + balance)
    if (entry.type === "restMoney") {
      const sellEntry = await Entry.findById(entry.linkedSellId);

      const oldRestMoney = Number(entry.restMoney || 0);
      const newRestMoney = Number(updateData.restMoney || oldRestMoney);
      const diff = newRestMoney - oldRestMoney;

      // update SELL.restMoney
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

      // adjust BALANCE (rest money = money in)
      let balance = await Balance.findOne();
      if (!balance) balance = await Balance.create({ amount: 0 });
      balance.amount += diff;
      await balance.save();

      // PROFIT if completed
      if (newAction === "completed") {
        await handleProfitLoss(entry.linkedSellId);
      } else {
        // if becomes processing → no profit
        await Entry.findByIdAndUpdate(entry.linkedSellId, {
          $set: { profitOrLoss: 0, profitType: "neutral" },
        });
      }
    }

    // 4️⃣ HANDLE SELL EDIT (advance change + profit)
    if (entry.type === "sell") {
      const total = Number(updateData.totalAmount ?? entry.totalAmount ?? 0);
      const newAdvance = Number(updateData.advance ?? entry.advance ?? 0);
      const rest = Number(entry.restMoney ?? 0);

      // Adjust BALANCE for advance diff
      const oldAdvance = Number(entry.advance || 0);
      const diffAdvance = newAdvance - oldAdvance;

      if (diffAdvance !== 0) {
        let balance = await Balance.findOne();
        if (!balance) balance = await Balance.create({ amount: 0 });
        balance.amount += diffAdvance; // creation added → adjust
        await balance.save();
      }

      const newAction =
        newAdvance + rest === total ? "completed" : "processing";
      updateData.action = newAction;

      if (newAction === "completed") {
        await handleProfitLoss(entry._id);
      } else {
        updateData.profitOrLoss = 0;
        updateData.profitType = "neutral";
      }
    }

    // reset status after edit
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

    // 2️⃣ PURCHASE → RESTORE BALANCE (total + delivery)
    else if (entry.type === "purchase") {
      balance.amount +=
        Number(entry.totalAmount || 0) + Number(entry.deliveryCharge || 0);
      await balance.save();
    }

    // ----------------------------------------------
    // 3️⃣ DELETE restMoney → reverse SELL + BALANCE
    // ----------------------------------------------
    else if (entry.type === "restMoney") {
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
            ...(newAction === "completed"
              ? {}
              : { profitOrLoss: 0, profitType: "neutral" }),
          },
        });

        if (newAction === "completed") {
          await handleProfitLoss(sell._id);
        }
      }

      // BALANCE: restMoney is money in → remove it on delete
      balance.amount -= Number(entry.restMoney || 0);
      await balance.save();
    }

    // ----------------------------------------------
    // 4️⃣ DELETE DELIVERY
    // ----------------------------------------------
    else if (entry.type === "delivery") {
      if (entry.note === "Delivery Charge (Own)") {
        balance.amount += Number(entry.totalAmount || 0); // reverse
        await balance.save();
        if (entry.linkedSellId) {
          await handleProfitLoss(entry.linkedSellId);
        }
      }
    }

    // 5️⃣ SELL → reverse all child effects
    else if (entry.type === "sell") {
      const sellId = entry._id;

      balance.amount -= Number(entry.advance || 0);

      const restEntries = await Entry.find({
        linkedSellId: sellId,
        type: "restMoney",
      });
      restEntries.forEach((r) => {
        balance.amount -= Number(r.restMoney || 0);
      });

      const purchaseEntries = await Entry.find({
        linkedSellId: sellId,
        type: "purchase",
      });
      purchaseEntries.forEach((p) => {
        balance.amount +=
          Number(p.totalAmount || 0) + Number(p.deliveryCharge || 0);
      });

      const deliveryOwnEntries = await Entry.find({
        linkedSellId: sellId,
        type: "delivery",
        note: "Delivery Charge (Own)",
      });
      deliveryOwnEntries.forEach((d) => {
        balance.amount += Number(d.totalAmount || 0);
      });

      await balance.save();

      await Entry.deleteMany({ linkedSellId: sellId });
    }

    // finally delete entry itself
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
    // -------------------- TODAY RANGE --------------------
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    // -------------------- THIS MONTH RANGE --------------------
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const monthEnd = new Date(); // now

    // Fetch all entries
    const entries = await Entry.find();

    // Today's entries only
    const todayEntries = await Entry.find({
      createdAt: { $gte: todayStart, $lte: todayEnd },
    });

    // This Month entries only
    const monthEntries = await Entry.find({
      createdAt: { $gte: monthStart, $lte: monthEnd },
    });

    // -------------------- TOTAL STATS --------------------
    const saleTotal = entries
      .filter((e) => e.type === "sell")
      .reduce((sum, e) => sum + Number(e.totalAmount || 0), 0);

    // Purchase Total + Delivery Charge Included
    const purchaseTotal = entries
      .filter((e) => e.type === "purchase")
      .reduce(
        (sum, e) =>
          sum + Number(e.totalAmount || 0) + Number(e.deliveryCharge || 0), // <---- ADD THIS
        0
      );
    const othersTotal = entries
      .filter((e) => e.type === "others")
      .reduce((sum, e) => sum + Number(e.totalAmount || 0), 0);

    const expenseTotal = entries
      .filter((e) => e.type === "expense")
      .reduce((sum, e) => sum + Number(e.totalAmount || 0), 0);

    const profitTotal = entries
      .filter((e) => e.profitType === "profit")
      .reduce((sum, e) => sum + Number(e.profitOrLoss || 0), 0);

    const lossTotal = entries
      .filter((e) => e.profitType === "loss")
      .reduce((sum, e) => sum + Number(e.profitOrLoss || 0), 0);

    // -------------------- TODAY STATS --------------------
    const todaySale = todayEntries
      .filter((e) => e.type === "sell")
      .reduce((sum, e) => sum + Number(e.totalAmount || 0), 0);

    const todayPurchase = todayEntries
      .filter((e) => e.type === "purchase")
      .reduce(
        (sum, e) =>
          sum + Number(e.totalAmount || 0) + Number(e.deliveryCharge || 0), // <---- ADD THIS
        0
      );
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

    // -------------------- THIS MONTH STATS --------------------
    const monthSale = monthEntries
      .filter((e) => e.type === "sell")
      .reduce((sum, e) => sum + Number(e.totalAmount || 0), 0);

    const monthPurchase = monthEntries
      .filter((e) => e.type === "purchase")
      .reduce(
        (sum, e) =>
          sum + Number(e.totalAmount || 0) + Number(e.deliveryCharge || 0), // <---- ADD THIS
        0
      );
    const monthExpense = monthEntries
      .filter((e) => e.type === "expense")
      .reduce((sum, e) => sum + Number(e.totalAmount || 0), 0);

    const monthOthers = monthEntries
      .filter((e) => e.type === "others")
      .reduce((sum, e) => sum + Number(e.totalAmount || 0), 0);

    const monthProfit = monthEntries
      .filter((e) => e.profitType === "profit")
      .reduce((sum, e) => sum + Number(e.profitOrLoss || 0), 0);

    const monthLoss = monthEntries
      .filter((e) => e.profitType === "loss")
      .reduce((sum, e) => sum + Number(e.profitOrLoss || 0), 0);

    // BALANCE
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
      month: {
        monthSale,
        monthPurchase,
        monthExpense,
        monthOthers,
        monthProfit,
        monthLoss,
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
