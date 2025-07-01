const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");

dotenv.config();
const stripe = require("stripe")(process.env.PAYMENT_GATEWAY_KEY);

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const serviceAccount = require("./firebase-admin-key.json");
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.j4wv0oh.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    },
});

async function run() {
    try {
        // Connect the client to the server	(optional starting in v4.7)
        await client.connect();

        const db = client.db("parcelDB");
        const usersCollection = db.collection("users");
        const parcelCollection = db.collection("parcels");
        const paymentsCollection = db.collection("payments");
        const ridersCollection = db.collection("riders");

        // custom middleWare
        const verifyFBToken = async (req, res, next) => {
            // console.log('header in middleware : ', req.headers);
            const authHeader = req.headers.authorization;
            if (!authHeader) {
                return res.status(401).send({ message: "unauthorized access" });
            }

            const token = authHeader.split(" ")[1];
            if (!token) {
                return res.status(401).send({ message: "unauthorized access" });
            }

            // verify the token
            try {
                const decoded = await admin.auth().verifyIdToken(token);
                req.decoded = decoded;
                next();
            } catch (error) {
                return res.status(403).send({ message: "forbidden access" });
            }
        };

        ///////////////////// USER related APIs //////////////////////////

        app.get("/users/search", async (req, res) => {
            const emailQuery = req.query.email;
            if (!emailQuery) {
                return res.status(400).send({ message: "Missing email query" });
            }

            const regex = new RegExp(emailQuery, "i"); // case-insensitive partial match

            try {
                const users = await usersCollection
                    .find({ email: { $regex: regex } })
                    // .project({ email: 1, createdAt: 1, role: 1 })
                    .limit(10)
                    .toArray();
                res.send(users);
            } catch (error) {
                console.error("Error searching users", error);
                res.status(500).send({ message: "Error searching users" });
            }
        });

        app.post("/users", async (req, res) => {
            const email = req.body.email;

            const userExist = await usersCollection.findOne({ email });

            if (userExist) {
                // TODO: update last log in info
                return res
                    .status(200)
                    .send({ message: "User already exists", inserted: false });
            }

            const user = req.body;
            const result = await usersCollection.insertOne(user);
            res.send(result);
        });

        app.patch(
            "/users/:id/role",
            verifyFBToken,
            
            async (req, res) => {
                const { id } = req.params;
                const { role } = req.body;

                if (!["admin", "user"].includes(role)) {
                    return res.status(400).send({ message: "Invalid role" });
                }

                try {
                    const result = await usersCollection.updateOne(
                        { _id: new ObjectId(id) },
                        { $set: { role } }
                    );
                    res.send({
                        message: `User role updated to ${role}`,
                        result,
                    });
                } catch (error) {
                    console.error("Error updating user role", error);
                    res.status(500).send({
                        message: "Failed to update user role",
                    });
                }
            }
        );

        ////////////////////// PARCEL related APIs /////////////////////////

        // app.get('/parcels', async(req, res)=>{
        //     const parcels = await parcelCollection.find().toArray();
        //     res.send(parcels);
        // })

        app.get("/parcels", verifyFBToken, async (req, res) => {
            try {
                const userEmail = req.query.email;

                // console.log(req.headers);

                const query = userEmail ? { created_by: userEmail } : {};
                const options = {
                    sort: { createdAt: -1 },
                };

                const parcels = await parcelCollection
                    .find(query, options)
                    .toArray();
                res.send(parcels);
            } catch (error) {
                console.error("Error fetching parcels: ", parcels);
                res.status(500).send({ message: "Failed to get parcels" });
            }
        });

        app.get("/parcels/:id", async (req, res) => {
            try {
                const id = req.params.id;
                const parcel = await parcelCollection.findOne({
                    _id: new ObjectId(id),
                });

                if (!parcel) {
                    return res
                        .status(404)
                        .send({ message: "Parcel not found" });
                }

                res.send(parcel);
            } catch (error) {
                console.error("error fetching parcel : ", error);
                res.status(500).send({ message: "Failed to fetch parcle" });
            }
        });

        app.post("/parcels", async (req, res) => {
            try {
                const newParcel = req.body;
                const result = await parcelCollection.insertOne(newParcel);
                res.status(201).send(result);
            } catch (error) {
                console.log("Error inserting parcel: ", error);
                res.status(500).send({ message: "Failed to create parcel" });
            }
        });

        app.post("/tracking", async (req, res) => {
            const {
                tracking_id,
                parcel_id,
                status,
                message,
                updated_by = "",
            } = req.body;

            const log = {
                tracking_id,
                parcel_id: parcel_id ? new ObjectId(parcel_id) : undefined,
                status,
                message,
                time: new Date(),
                updated_by,
            };

            const result = await trackingCollection.insertOne(log);
            res.send({ success: true, insertedId: result.insertedId });
        });

        app.delete("/parcels/:id", async (req, res) => {
            try {
                const id = req.params.id;

                const result = await parcelCollection.deleteOne({
                    _id: new ObjectId(id),
                });

                res.send(result);
            } catch (error) {
                console.error("Error deleting parcel: ", error);
                res.status(500).send({ message: "Failed to delete parcel" });
            }
        });

        ///////////////////// PAYMENT related APIs /////////////////////////

        app.get("/payments", verifyFBToken, async (req, res) => {
            // console.log('headers in payment :', req.headers);
            try {
                const userEmail = req.query.email;

                console.log("decoded in getting payments : ", req.decoded);
                if (req.decoded.email !== userEmail) {
                    return res
                        .status(403)
                        .send({ message: "forbidden access" });
                }

                const query = userEmail ? { email: userEmail } : {};
                const options = { sort: { paid_at: -1 } }; // Latest first

                const payments = await paymentsCollection
                    .find(query, options)
                    .toArray();
                res.send(payments);
            } catch (error) {
                console.error("Error fetching payment history:", error);
                res.status(500).send({ message: "Failed to get payments" });
            }
        });

        // POST: Record payment and update parcel status
        app.post("/payments", async (req, res) => {
            try {
                const {
                    parcelId,
                    email,
                    amount,
                    paymentMethod,
                    transactionId,
                } = req.body;

                // 1. Update parcel's payment_status
                const updateResult = await parcelCollection.updateOne(
                    { _id: new ObjectId(parcelId) },
                    {
                        $set: {
                            payment_status: "paid",
                        },
                    }
                );

                if (updateResult.modifiedCount === 0) {
                    return res
                        .status(404)
                        .send({ message: "Parcel not found or already paid" });
                }

                // 2. Insert payment record
                const paymentDoc = {
                    parcelId,
                    email,
                    amount,
                    paymentMethod,
                    transactionId,
                    paid_at_string: new Date().toISOString(),
                    paid_at: new Date(),
                };

                const paymentResult = await paymentsCollection.insertOne(
                    paymentDoc
                );

                res.status(201).send({
                    message: "Payment recorded and parcel marked as paid",
                    insertedId: paymentResult.insertedId,
                });
            } catch (error) {
                console.error("Payment processing failed:", error);
                res.status(500).send({ message: "Failed to record payment" });
            }
        });

        app.post("/create-payment-intent", async (req, res) => {
            const amountInCents = req.body.amountInCents;
            try {
                const paymentIntent = await stripe.paymentIntents.create({
                    amount: amountInCents,
                    currency: "usd",
                    payment_method_types: ["card"],
                });

                res.json({ clientSecret: paymentIntent.client_secret });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        ////////////////// RIDER related APIs ///////////////////

        app.get("/riders/pending", async (req, res) => {
            try {
                const pendingRiders = await ridersCollection
                    .find({ status: "pending" })
                    .toArray();

                res.send(pendingRiders);
            } catch (error) {
                console.error("Failed to load pending riders:", error);
                res.status(500).send({
                    message: "Failed to load pending riders",
                });
            }
        });

        app.get("/riders/active", async (req, res) => {
            const result = await ridersCollection
                .find({ status: "active" })
                .toArray();
            res.send(result);
        });

        app.patch("/riders/:id/status", async (req, res) => {
            const { id } = req.params;
            const { status, email } = req.body;
            const query = { _id: new ObjectId(id) };
            const updateDoc = {
                $set: {
                    status,
                },
            };

            try {
                const result = await ridersCollection.updateOne(
                    query,
                    updateDoc
                );

                // update user role for accepting rider
                if (status === "active") {
                    const userQuery = { email };
                    const userUpdatedDoc = {
                        $set: {
                            role: "rider",
                        },
                    };
                    const roleResult = await usersCollection.updateOne(
                        userQuery,
                        userUpdatedDoc
                    );
                    console.log(roleResult.modifiedCount);
                }

                res.send(result);
            } catch (err) {
                res.status(500).send({
                    message: "Failed to update rider status",
                });
            }
        });

        app.post("/riders", async (req, res) => {
            const rider = req.body;
            const result = await ridersCollection.insertOne(rider);
            res.send(result);
        });

        // Send a ping to confirm a successful connection
        await client.db("admin").command({ ping: 1 });
        console.log(
            "Pinged your deployment. You successfully connected to MongoDB!"
        );
    } finally {
        // Ensures that the client will close when you finish/error
        // await client.close();
    }
}
run().catch(console.dir);

app.get("/", (req, res) => {
    res.send("Parcel Server is running");
});

app.listen(port, () => {
    console.log(`Parcel Server is running on port : ${port}`);
});
