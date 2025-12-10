require("dotenv").config();
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const app = express();
const port = process.env.PORT || 3000;

// Middlewares
app.use(cors());
app.use(express.json());

// MongoDB setup
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.dy2dskh.mongodb.net/?retryWrites=true&w=majority`;
const client = new MongoClient(uri, { serverApi: { version: ServerApiVersion.v1 } });


async function run() {
  try {
    await client.connect();
    console.log("✅ MongoDB Connected");

    const db = client.db("urbanFixDB");
    const usersCollection = db.collection("users");
    const issuesCollection = db.collection("issues");

    

    // ---------------- REGISTER ----------------
    app.post("/register", async (req, res) => {
      const { email, name, password } = req.body;
      const exists = await usersCollection.findOne({ email });
      if (exists) return res.status(400).send({ message: "User already exists" });

      const user = { email, name, password, role: "citizen", createdAt: new Date() };
      await usersCollection.insertOne(user);
      const token = signToken({ email, role: "citizen" });

      res.send({ token, user });
    });

    // ---------------- LOGIN ----------------
    app.post("/login", async (req, res) => {
      const { email, password } = req.body;
      const user = await usersCollection.findOne({ email });
      if (!user) return res.status(404).send({ message: "User not found" });
      if (user.password !== password) return res.status(401).send({ message: "Wrong password" });

      const token = signToken({ email, role: user.role });
      res.send({ token, user });
    });

    // ---------------- GET ISSUES ----------------
    app.get("/issues", optionalJWT, async (req, res) => {
      const { page = 1, limit = 20, search, category, status, postedBy } = req.query;
      const query = {};

      if (search) {
        const regex = new RegExp(search, "i");
        query.$or = [
          { title: { $regex: regex } },
          { description: { $regex: regex } },
          { location: { $regex: regex } }
        ];
      }

      if (category) query.category = category;
      if (status) query.status = status;
      if (postedBy) query.postedBy = postedBy;

      const skip = (page - 1) * parseInt(limit);
      const total = await issuesCollection.countDocuments(query);
      const issues = await issuesCollection.find(query).skip(skip).limit(parseInt(limit)).toArray();

      res.send({ total, page: parseInt(page), limit: parseInt(limit), issues });
    });

    // ---------------- GET SINGLE ISSUE ----------------
    app.get("/issues/:id", async (req, res) => {
      const id = req.params.id;
      const issue = await issuesCollection.findOne({ _id: new ObjectId(id) });
      if (!issue) return res.status(404).send({ message: "Issue not found" });
      res.send(issue);
    });

    

    // ---------------- HOME ----------------
    app.get("/", (req, res) => {
      res.send("UrbanFix backend is running...");
    });

  } catch (err) {
    console.error(err);
  }
}

run().catch(console.dir);

app.listen(port, () => console.log(`🚀 Server running on port ${port}`));
