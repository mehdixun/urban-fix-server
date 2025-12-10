require("dotenv").config();
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// MongoDB setup
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.dy2dskh.mongodb.net/?retryWrites=true&w=majority`;
const client = new MongoClient(uri, { serverApi: { version: ServerApiVersion.v1 } });

// JWT helper
const signToken = (payload) =>
  jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "7d" });

// Optional JWT middleware
const optionalJWT = (req, res, next) => {
  const header = req.headers.authorization;
  if (!header) {
    req.user = undefined;
    return next();
  }
  const token = header.split(" ")[1];
  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) req.user = undefined;
    else req.user = decoded;
    next();
  });
};

// Middleware to protect admin routes
const verifyAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== "admin")
    return res.status(403).send({ message: "Admin access required" });
  next();
};

async function run() {
  try {
    await client.connect();
    console.log("✅ MongoDB Connected");

    const db = client.db("urbanFixDB");
    const usersCollection = db.collection("users");
    const issuesCollection = db.collection("issues");

    // ---------------- JWT ----------------
    app.post("/jwt", async (req, res) => {
      const { email } = req.body;
      const user = await usersCollection.findOne({ email: email.toLowerCase() });
      const role = user?.role || "citizen";
      const token = signToken({ email, role });
      res.send({ token });
    });

    // ---------------- REGISTER / CREATE USER ----------------
    app.post("/users", async (req, res) => {
      try {
        const { name, email, phone, password, role, isBlocked, isPremium } = req.body;
        if (!name || !email || !password)
          return res.status(400).send({ message: "Name, email & password are required" });

        const exists = await usersCollection.findOne({ email: email.toLowerCase() });
        if (exists) return res.status(400).send({ message: "User already exists" });

        const user = {
          name,
          email: email.toLowerCase(),
          phone: phone || "",
          password,
          role: role || "citizen",
          isBlocked: isBlocked || false,
          isPremium: isPremium || false,
          createdAt: new Date()
        };

        await usersCollection.insertOne(user);
        const { password: _, ...cleanUser } = user;
        res.send({ message: "User created successfully", user: cleanUser });
      } catch (err) {
        res.status(500).send({ message: err.message });
      }
    });

    // ---------------- GET ALL USERS ----------------
    app.get("/users", async (req, res) => {
      try {
        const users = await usersCollection.find().toArray();
        const cleanUsers = users.map(u => {
          const { password, ...rest } = u;
          return rest;
        });
        res.send(cleanUsers);
      } catch (err) {
        res.status(500).send({ message: err.message });
      }
    });

    // ---------------- GET SINGLE USER ----------------
    app.get("/users/:email", optionalJWT, async (req, res) => {
      try {
        const email = req.params.email.toLowerCase();
        const user = await usersCollection.findOne({ email });
        if (!user) return res.status(404).send({ message: "User not found" });
        const { password, ...clean } = user;
        res.send(clean);
      } catch (err) {
        res.status(500).send({ message: err.message });
      }
    });

    // ---------------- UPDATE USER ----------------
    app.put("/users/:email", optionalJWT, async (req, res) => {
      try {
        const email = req.params.email.toLowerCase();
        const { name, phone, photoURL, role, isBlocked, isPremium } = req.body;
        const result = await usersCollection.findOneAndUpdate(
          { email },
          { $set: { name, phone, photoURL, role, isBlocked, isPremium } },
          { returnDocument: "after" }
        );
        if (!result.value) return res.status(404).send({ message: "User not found" });
        const { password, ...updatedUser } = result.value;
        res.send({ message: "User updated successfully", user: updatedUser });
      } catch (err) {
        res.status(500).send({ message: err.message });
      }
    });

    // ---------------- ADMIN ROUTES ----------------
    app.patch("/admin/users/block/:email", optionalJWT, verifyAdmin, async (req, res) => {
      try {
        const email = req.params.email.toLowerCase();
        const user = await usersCollection.findOne({ email });
        if (!user) return res.status(404).send({ message: "User not found" });
        const newStatus = !user.isBlocked;
        await usersCollection.updateOne({ email }, { $set: { isBlocked: newStatus } });
        res.send({ message: `User ${newStatus ? "blocked" : "unblocked"} successfully` });
      } catch (err) {
        res.status(500).send({ message: err.message });
      }
    });

    // ---------------- ISSUES ROUTES (UNCHANGED) ----------------
    app.get("/issues", optionalJWT, async (req, res) => {
      const { page = 1, limit = 20, search, category, status, postedBy } = req.query;
      const query = {};
      if (search) {
        const regex = new RegExp(search, "i");
        query.$or = [
          { title: { $regex: regex } },
          { description: { $regex: regex } },
          { location: { $regex: regex } },
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

    app.get("/issues/:id", async (req, res) => {
      const id = req.params.id;
      const issue = await issuesCollection.findOne({ _id: new ObjectId(id) });
      if (!issue) return res.status(404).send({ message: "Issue not found" });
      res.send(issue);
    });

    app.post("/issues", optionalJWT, async (req, res) => {
      const issue = req.body;
      issue.status = "Pending";
      issue.upvotes = 0;
      issue.upvotedUsers = [];
      issue.createdAt = new Date();
      issue.timeline = [{ status: "Pending", message: "Issue reported", updatedBy: issue.postedBy, date: new Date() }];
      const result = await issuesCollection.insertOne(issue);
      res.send(result);
    });

    app.put("/issues/:id", async (req, res) => {
      const id = req.params.id;
      const { title, description, category, location } = req.body;
      const result = await issuesCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { title, description, category, location } }
      );
      if (result.matchedCount === 0) return res.status(404).send({ message: "Issue not found" });
      res.send({ message: "Issue updated successfully" });
    });

    app.delete("/issues/:id", async (req, res) => {
      const id = req.params.id;
      const result = await issuesCollection.deleteOne({ _id: new ObjectId(id) });
      if (result.deletedCount === 0) return res.status(404).send({ message: "Issue not found" });
      res.send({ message: "Issue deleted successfully" });
    });

    app.get("/", (req, res) => res.send("UrbanFix backend is running..."));
  } catch (err) {
    console.error(err);
  }
}

run().catch(console.dir);
app.listen(port, () => console.log(`🚀 Server running on port ${port}`));
