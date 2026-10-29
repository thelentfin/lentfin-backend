const jwt = require("jsonwebtoken");
const { logAuditAction } = require("../utils/auditLogger");

let io;
const activeUserSockets = new Map(); // userKey -> Set of socket.ids
const disconnectTimers = new Map(); // userKey -> setTimeout handle

/**
 * Cancel any pending disconnect timer for a user (e.g. on page reload or manual logout)
 */
const cancelDisconnectTimer = (userKey) => {
  if (disconnectTimers.has(userKey)) {
    clearTimeout(disconnectTimers.get(userKey));
    disconnectTimers.delete(userKey);
  }
};

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
    if (!user || !user.id) return;

    const userKey = `${user.role}_${user.id}`;

    // Track active socket
    if (!activeUserSockets.has(userKey)) {
      activeUserSockets.set(userKey, new Set());
    }
    activeUserSockets.get(userKey).add(socket.id);

    // If there was a pending disconnect timer (from F5 reload or temporary blip), cancel it
    cancelDisconnectTimer(userKey);

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

      const sockets = activeUserSockets.get(userKey);
      if (sockets) {
        sockets.delete(socket.id);

        // If user has closed all tabs for this account
        if (sockets.size === 0) {
          activeUserSockets.delete(userKey);

          // Start a 20-second grace period buffer to differentiate page refreshes (F5) from real tab closures
          const timer = setTimeout(() => {
            disconnectTimers.delete(userKey);

            const roleLabel =
              user.role === "admin"
                ? "Admin"
                : user.role === "DSA"
                ? "DSA Partner"
                : user.role;
            const userName = user.username || user.name || roleLabel;
            const clientIp = socket.handshake.address || null;

            logAuditAction({
              actorId: user.id,
              actorName: userName,
              actorRole: roleLabel,
              actionType: "SESSION_ENDED",
              module: "Authentication",
              entityId: `USER-${user.id}`,
              summary: `${userName} session ended (Browser / Tab closed).`,
              newValue: "TAB_CLOSED",
              ipAddress: clientIp,
            });
          }, 20000);

          disconnectTimers.set(userKey, timer);
        }
      }
    });
  });
};

const getIO = () => io;

module.exports = { initializeSocket, getIO, cancelDisconnectTimer };
