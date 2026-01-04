import express from "express";

const app = express();

// Healthcheck para o Render
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

// Porta padrão do Render: process.env.PORT
const PORT = Number(process.env.PORT) || 3000;

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
