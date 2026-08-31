const express = require("express");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const router = express.Router();
const Checkout = require("../models/Checkout");
const { calculateShippingPrice } = require("../services/shippingService");

function authMiddleware(req, res, next) {
  const token = req.cookies?.admin_token;
  if (!token) return res.status(401).json({ error: "غير مصرح" });
  try {
    req.admin = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "غير مصرح" });
  }
}

const checkoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV !== "production",
  message: { ok: false, error: "عذراً، تم تقديم عدة طلبات متتالية. يرجى الانتظار قليلاً قبل المحاولة مرة أخرى" },
});

router.post("/", checkoutLimiter, async (req, res) => {
  try {
    const { whatsapp, nationalId, shipping: shippingInput, items, total } = req.body;
    if (process.env.NODE_ENV === "production" && (whatsapp || nationalId)) {
      const since = new Date(Date.now() - 15 * 60 * 1000);
      const filter = { createdAt: { $gte: since } };
      if (whatsapp) filter.whatsapp = whatsapp;
      else filter.nationalId = nationalId;
      const recentCount = await Checkout.countDocuments(filter);
      if (recentCount >= 3) {
        return res.status(429).json({ ok: false, error: "عذراً، تم تقديم عدة طلبات من نفس الحساب. يرجى الانتظار قليلاً" });
      }
    }

    // Server-side shipping validation (only when companyId is a valid ObjectId)
    let shippingSnapshot = null;
    const isValidObjectId = (id) => /^[a-f\d]{24}$/i.test(id);
    if (shippingInput?.companyId && shippingInput?.region && isValidObjectId(shippingInput.companyId)) {
      const cartTotal = Number(total) || 0;
      const verified = await calculateShippingPrice(
        shippingInput.companyId,
        shippingInput.region,
        shippingInput.city || "",
        cartTotal
      );
      if (!verified) {
        return res.status(400).json({ ok: false, error: "شركة الشحن المختارة لا تغطي هذا العنوان" });
      }
      shippingSnapshot = {
        companyId: shippingInput.companyId,
        companyName: verified.companyName,
        logo: verified.logo,
        price: verified.price,
        originalPrice: verified.originalPrice,
        isFree: verified.isFree,
        deliveryMinDays: verified.deliveryMinDays,
        deliveryMaxDays: verified.deliveryMaxDays,
        region: shippingInput.region,
        city: shippingInput.city || "",
      };
    } else if (shippingInput?.companyId && shippingInput?.companyName) {
      // Fallback: store shipping as-is when companyId is a slug (not ObjectId)
      shippingSnapshot = {
        companyId: shippingInput.companyId,
        companyName: shippingInput.companyName,
        logo: shippingInput.logo || "",
        price: Number(shippingInput.price) || 0,
        originalPrice: Number(shippingInput.originalPrice) || 0,
        isFree: shippingInput.isFree ?? true,
        deliveryMinDays: shippingInput.deliveryMinDays || null,
        deliveryMaxDays: shippingInput.deliveryMaxDays || null,
        region: shippingInput.region || "",
        city: shippingInput.city || "",
      };
    }

    const payload = { ...req.body };
    if (shippingSnapshot) payload.shipping = shippingSnapshot;

    const checkout = new Checkout(payload);
    await checkout.save();
    res.status(201).json({ ok: true, orderId: checkout.orderId, _id: checkout._id });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get("/", async (req, res) => {
  try {
    const orders = await Checkout.find().sort({ createdAt: -1 });
    res.json(orders);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const order = await Checkout.findById(req.params.id);
    if (!order) return res.status(404).json({ ok: false, error: "not found" });
    res.json(order);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.put("/:id/status", authMiddleware, async (req, res) => {
  try {
    const order = await Checkout.findByIdAndUpdate(
      req.params.id,
      { status: req.body.status },
      { new: true }
    );
    res.json(order);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Public confirm after OTP — only allows "confirmed" status
router.put("/:id/confirm", async (req, res) => {
  try {
    const order = await Checkout.findByIdAndUpdate(
      req.params.id,
      { status: "confirmed" },
      { new: true }
    );
    if (!order) return res.status(404).json({ ok: false, error: "not found" });
    res.json({ ok: true, orderId: order.orderId });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.put("/:id/financials", authMiddleware, async (req, res) => {
  try {
    const { total, downPayment, months, monthlyPayment } = req.body;
    const order = await Checkout.findByIdAndUpdate(
      req.params.id,
      { total, downPayment, months, monthlyPayment },
      { new: true }
    );
    res.json(order);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    const order = await Checkout.findByIdAndDelete(req.params.id);
    if (!order) return res.status(404).json({ ok: false, error: "not found" });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
