const express = require("express");
const cors = require("cors");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");

require("dotenv").config();

const { initializeSocket } = require("./config/socket");

const app = express();
const server = http.createServer(app);

// ======================================================
// SOCKET.IO
// ======================================================

const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE"],
  },
});

// Initialize Socket
initializeSocket(io);

// Make io available in all routes
app.set("io", io);

// ======================================================
// ROUTES IMPORT
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
const dashboardRoutes = require("./routes/dashboardroutes");

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
// API ROUTES
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
app.use("/api/users", userRoutes);
app.use("/api/admin", adminForgetPasswordRoutes);
app.use("/api/dashboard", dashboardRoutes);

// ======================================================
// SERVER START
// ======================================================

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
