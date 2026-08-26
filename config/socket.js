const jwt = require("jsonwebtoken");

let io;

const initializeSocket = (socketIo) => {
  io = socketIo;

  // JWT Authentication
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
      next(new Error("Invalid token"));
    }
  });

  io.on("connection", (socket) => {
    console.log("Socket Connected:", socket.id);

    const user = socket.user;

    // Admin & Corporate DSA same room
    if (user.role === "admin" || user.role === "Corporate DSA") {
      socket.join("admin");
    }

    // DSA own room
    if (user.role === "DSA") {
      socket.join(`dsa_${user.id}`);
    }

    console.log(`User ${user.id} joined`);

    socket.on("disconnect", () => {
      console.log("Socket Disconnected:", socket.id);
    });
  });
};

const getIO = () => io;

module.exports = { initializeSocket, getIO };
