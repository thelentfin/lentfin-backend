let io;

const initializeSocket = (socketIo) => {
  io = socketIo;

  io.on("connection", (socket) => {
    console.log("Socket Connected:", socket.id);

    socket.on("join", (user) => {
      // Admin & Corporate DSA same room
      if (user.role === "admin" || user.role === "Corporate DSA") {
        socket.join("admin");
      }

      // DSA own room
      if (user.role === "DSA") {
        socket.join(`dsa_${user.id}`);
      }
    });

    socket.on("disconnect", () => {
      console.log("Socket Disconnected:", socket.id);
    });
  });
};

const getIO = () => io;

module.exports = { initializeSocket, getIO };
