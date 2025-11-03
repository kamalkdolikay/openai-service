import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import { verifyJWT } from "./middleware/auth.js";
import openaiRoutes from "./routes/openai.js";

dotenv.config();

const app = express();
app.use(express.json());

// Enable CORS for all origins
app.use(cors({
  origin: "*",            // allow any origin
  methods: ["GET","POST"],
  allowedHeaders: ["Content-Type","Authorization"],
  credentials: true       // allow cookies (optional)
}));

// Secure OpenAI routes
app.use("/api/openai", verifyJWT, openaiRoutes);

// Export for Vercel
export default app;

// Local mode (only if run directly)
if (!process.env.VERCEL) {
  const port = process.env.PORT || 4000;
  app.listen(port, () => {
    console.log(`OpenAI service running locally on port ${port}`);
  });
}
