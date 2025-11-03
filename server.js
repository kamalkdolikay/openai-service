import express from "express";
import dotenv from "dotenv";
import { verifyJWT } from "./middleware/auth.js";
import openaiRoutes from "./routes/openai.js";

dotenv.config();

const app = express();
app.use(express.json());

// Secure OpenAI routes
app.use("/api/openai", verifyJWT, openaiRoutes);

// Export for Vercel
export default app;

// Local mode (only if run directly)
if (process.env.VERCEL !== "1") {
  const port = process.env.PORT || 4000;
  app.listen(port, () => {
    console.log(`OpenAI service running locally on port ${port}`);
  });
}
