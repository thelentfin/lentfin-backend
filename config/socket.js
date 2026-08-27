const jwt = require("jsonwebtoken");

let io;

const initializeSocket = (socketIo) => {
  io = socketIo;

  // ======================================================
  // JWT AUTHENTICATION
  // ======================================================

  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth.token;

      if (!token) {
        return next(new Error("Authentication required"));
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      socket.user = decoded;

      next();
    } catch (err) {
      return next(new Error("Invalid token"));
    }
  });

  // ======================================================
  // SOCKET CONNECTION
  // ======================================================

  io.on("connection", (socket) => {
    console.log("Socket Connected:", socket.id);

    const user = socket.user;

    // Admin room
    if (user.role === "admin") {
      socket.join("admin");
      console.log(`Admin joined: ${socket.id}`);
    }

    // Corporate DSA room
    if (user.role === "Corporate DSA") {
      socket.join("corporate");
      console.log(`Corporate DSA joined: ${socket.id}`);
    }

    // DSA own room
    if (user.role === "DSA") {
      socket.join(`dsa_${user.id}`);
      console.log(`DSA ${user.id} joined room dsa_${user.id}`);
    }

    // ======================================================
    // DISCONNECT
    // ======================================================

    socket.on("disconnect", () => {
      console.log("Socket Disconnected:", socket.id);
    });
  });
};

const getIO = () => io;

module.exports = { initializeSocket, getIO };
