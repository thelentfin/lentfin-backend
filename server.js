const express = require("express");
const cors = require("cors");
const path = require("path");

require("dotenv").config();

const app = express();

// ======================================================
// ROUTES
// ======================================================

const loginRoutes = require("./routes/loginroutes");
const dsaRoutes = require("./routes/dsaroutes");
const companyRoutes = require("./routes/companyroutes");
const locationRoutes = require("./routes/locationroutes");
const forgotPasswordRoutes = require("./routes/forgotPasswordRoutes");
const bankRoutes = require("./routes/bankroutes");
const loanCaseRoutes = require("./routes/loancaseroutes");
const loanDisbursementRoutes = require("./routes/loanDisbursementRoutes");
const loanCaseSmAsmRoutes = require("./routes/loancasesmasmroutes");
const userRoutes = require("./routes/userroutes");
const loanPaymentRoutes = require("./routes/loanPaymentRoutes");
const notificationRoutes = require("./routes/Notificationroutes");
const adminForgetPasswordRoutes = require("./routes/adminForgetPassword");

// ======================================================
// CORS
// ======================================================

app.use(
  cors({
    origin: process.env.CLIENT_URL,
    credentials: true,
  }),
);

// ======================================================
// BODY PARSER
// ======================================================

app.use(express.json());

// ======================================================
// STATIC UPLOADS
// ======================================================

app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// ======================================================
// ROUTES
// ======================================================

app.use("/api/company", companyRoutes);

app.use("/api/location", locationRoutes);

app.use("/api", loginRoutes);

app.use("/api", forgotPasswordRoutes);

app.use("/api", dsaRoutes);

app.use("/api/bank", bankRoutes);

app.use("/api/loan-case", loanCaseRoutes);

app.use("/api/loan-disbursement", loanDisbursementRoutes);
app.use("/api/loan-case-sm-asm", loanCaseSmAsmRoutes);
app.use("/api/loan-payment", loanPaymentRoutes);
app.use("/api/notifications", notificationRoutes);
// USERS
// ======================================================
//added user routes
app.use("/api/users", userRoutes);
app.use("/api/admin", adminForgetPasswordRoutes);

// ======================================================
// SERVER
// ======================================================

app.listen(5000, () => {
  console.log("Server running on 5000");
});
