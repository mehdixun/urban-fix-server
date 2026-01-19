require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET);

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ---------- MongoDB ----------
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.dy2dskh.mongodb.net/?retryWrites=true&w=majority`;
const client = new MongoClient(uri, { serverApi: { version: ServerApiVersion.v1 } });

let usersCollection, issuesCollection, paymentsCollection;

async function run() {
  try {
    // await client.connect();
    console.log("MongoDB Connected");

    const db = client.db("urbanFixDB");
    usersCollection = db.collection("users");
    issuesCollection = db.collection("issues");
    paymentsCollection = db.collection("payments");

    await usersCollection.createIndex({ email: 1 }, { unique: true });
    await paymentsCollection.createIndex({ sessionId: 1 }, { unique: true });

    //USERS
    app.post("/users", async (req, res) => {
      const { email, name, photoURL, role } = req.body;
      const userDoc = {
        email: email.toLowerCase(),
        name: name || "",
        photoURL: photoURL || "",
        role: role || "citizen",
        updatedAt: new Date(),
      };
      await usersCollection.updateOne(
        { email: userDoc.email },
        { $set: userDoc, $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
      );
      const user = await usersCollection.findOne({ email: userDoc.email });
      res.send(user);
    });

    app.get("/users/:email", async (req, res) => {
      const email = req.params.email.toLowerCase();
      const user = await usersCollection.findOne({ email });
      if (!user) return res.status(404).send({ message: "User not found" });
      res.send(user);
    });

    app.put("/users/:email", async (req, res) => {
      const email = req.params.email.toLowerCase();
      const { name, photoURL } = req.body;
      const result = await usersCollection.findOneAndUpdate(
        { email },
        { $set: { name, photoURL, updatedAt: new Date() } },
        { returnDocument: "after" }
      );
      res.send({ user: result.value });
    });

    // PAYMENTS SECTION 
    app.post("/create-checkout-session", async (req, res) => {
      const { cost, userEmail } = req.body;
      try {
        const session = await stripe.checkout.sessions.create({
          payment_method_types: ["card"],
          mode: "payment",
          line_items: [
            {
              price_data: {
                currency: "usd",
                product_data: { name: "UrbanFix Premium Service" },
                unit_amount: cost * 100,
              },
              quantity: 1,
            },
          ],
          success_url: `https://urban-fix.netlify.app/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `https://urban-fix.netlify.app/dashboard/payment-cancel`,
        });
        res.send({ url: session.url, sessionId: session.id });
      } catch (err) {
        console.error(err);
        res.status(500).send({ message: "Failed to create session" });
      }
    });

    app.post("/payments/verify", async (req, res) => {
      const { sessionId, email } = req.body;
      try {
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        if (session.payment_status !== "paid") return res.status(400).send({ message: "Payment not completed" });

        const exists = await paymentsCollection.findOne({ sessionId });
        if (exists) return res.send({ message: "Already verified" });

        const paymentDoc = {
          userEmail: email.toLowerCase(),
          amount: session.amount_total / 100,
          transactionId: session.payment_intent,
          sessionId,
          status: "Paid",
          method: "Card",
          createdAt: new Date(),
        };

        await paymentsCollection.insertOne(paymentDoc);
        res.send(paymentDoc);
      } catch (err) {
        console.error(err);
        res.status(500).send({ message: "Verification failed" });
      }
    });

    app.get("/payments/:email", async (req, res) => {
      const email = req.params.email.toLowerCase();
      const payments = await paymentsCollection
        .find({ userEmail: email })
        .sort({ createdAt: -1 })
        .toArray();
      res.send(payments);
    });

    // ISSUES 
    app.get("/issues", async (req, res) => {
      const issues = await issuesCollection.find().sort({ createdAt: -1 }).toArray();
      res.send(issues);
    });

    app.get("/issues/my/:email", async (req, res) => {
      const email = req.params.email.toLowerCase();
      const issues = await issuesCollection.find({ "postedBy.email": email }).sort({ createdAt: -1 }).toArray();
      res.send(issues);
    });

    app.get("/issues/:id", async (req, res) => {
      const { id } = req.params;
      if (!ObjectId.isValid(id)) return res.status(400).send({ message: "Invalid ID" });
      const issue = await issuesCollection.findOne({ _id: new ObjectId(id) });
      if (!issue) return res.status(404).send({ message: "Issue not found" });
      res.send(issue);
    });

    app.post("/issues", async (req, res) => {
      const p = req.body;
      const issueDoc = {
        title: p.title,
        description: p.description || "",
        location: p.location || "",
        category: p.category || "General",
        status: "Pending",
        priority: p.priority || "Normal",
        postedBy: {
          email: p.postedBy?.email || "",
          name: p.postedBy?.name || "",
          photoURL: p.postedBy?.photoURL || "",
        },
        image: p.image || "",
        upvotes: 0,
        upvotedUsers: [],
        timeline: p.timeline || [
          {
            status: "Pending",
            message: "Issue reported by citizen",
            updatedBy: p.postedBy?.email || "Unknown",
            date: new Date(),
          },
        ],
        createdAt: new Date(),
      };
      await issuesCollection.insertOne(issueDoc);
      res.send(issueDoc);
    });

    app.put("/issues/:id", async (req, res) => {
      const { id } = req.params;
      if (!ObjectId.isValid(id)) return res.status(400).send({ message: "Invalid ID" });

      const { title, description, category, location, image, userEmail } = req.body;
      const issue = await issuesCollection.findOne({ _id: new ObjectId(id) });
      if (!issue) return res.status(404).send({ message: "Issue not found" });

      if (userEmail && issue.postedBy.email !== userEmail) return res.status(403).send({ message: "Unauthorized" });

      const updateDoc = { title, description, category, location, ...(image && { image }), updatedAt: new Date() };
      await issuesCollection.updateOne({ _id: new ObjectId(id) }, { $set: updateDoc });
      const updatedIssue = await issuesCollection.findOne({ _id: new ObjectId(id) });
      res.send(updatedIssue);
    });

    app.delete("/issues/:id", async (req, res) => {
      const { id } = req.params;
      const { userEmail } = req.body;
      if (!ObjectId.isValid(id)) return res.status(400).send({ message: "Invalid ID" });

      const issue = await issuesCollection.findOne({ _id: new ObjectId(id) });
      if (!issue) return res.status(404).send({ message: "Issue not found" });

      if (userEmail && issue.postedBy.email !== userEmail) return res.status(403).send({ message: "Unauthorized" });

      await issuesCollection.deleteOne({ _id: new ObjectId(id) });
      res.send({ message: "Issue deleted successfully" });
    });

    // UPVOTE
    app.put("/issues/:id/upvote", async (req, res) => {
      const { id } = req.params;
      const { userEmail } = req.body;

      if (!ObjectId.isValid(id)) return res.status(400).send({ message: "Invalid ID" });

      const issue = await issuesCollection.findOne({ _id: new ObjectId(id) });
      if (!issue) return res.status(404).send({ message: "Issue not found" });

      if (issue.postedBy?.email === userEmail) return res.status(400).send({ message: "Cannot upvote own issue" });

      const alreadyUpvoted = issue.upvotedUsers?.includes(userEmail);
      if (alreadyUpvoted) return res.status(400).send({ message: "Already upvoted" });

      const updatedUpvotedUsers = [...(issue.upvotedUsers || []), userEmail];
      const updatedUpvotes = (issue.upvotes || 0) + 1;

      await issuesCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { upvotes: updatedUpvotes, upvotedUsers: updatedUpvotedUsers } }
      );

      const updatedIssue = await issuesCollection.findOne({ _id: new ObjectId(id) });
      res.send(updatedIssue);
    });

    app.listen(port, () => console.log(`Server running on http://localhost:${port}`));
    app.get("/", (_, res) => res.send(" UrbanFix Backend Running"));
  } catch (err) {
    console.error(" Backend Error:", err);
  }
}

run();
