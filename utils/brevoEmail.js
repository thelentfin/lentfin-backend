const { BrevoClient } = require("@getbrevo/brevo");

const brevo = new BrevoClient({
  apiKey: process.env.BREVO_API_KEY,
});

const sendEmail = async ({ to, toName, subject, htmlContent }) => {
  try {
    const response = await brevo.transactionalEmails.sendTransacEmail({
      sender: {
        name: process.env.BREVO_SENDER_NAME,
        email: process.env.BREVO_SENDER_EMAIL,
      },

      to: [
        {
          email: to,
          name: toName || "",
        },
      ],

      subject,
      htmlContent,
    });

    console.log("BREVO EMAIL SENT:", response.messageId);

    return {
      success: true,
      messageId: response.messageId,
    };
  } catch (error) {
    console.error("BREVO EMAIL ERROR:", error);

    return {
      success: false,
      error: error.message,
    };
  }
};

module.exports = {
  sendEmail,
};
