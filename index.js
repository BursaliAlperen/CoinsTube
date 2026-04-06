require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const admin = require('firebase-admin');

// Render'ın Secret Files kısmından bu dosyayı otomatik okuyacak
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://shortstube-earn-default-rtdb.firebaseio.com" // Firebase veritabanı URL'n
});

const db = admin.database();
const app = express();
app.use(cors());
app.use(express.json());

// Frontend (HTML) dosyanı internete sunar
app.use(express.static('public'));

const TARGET_REWARD = 0.005; // İzleme başı ödül
const REF_PERCENTAGE = 0.10; // Referans kazancı oranı

app.get('/api/user/:id', async (req, res) => {
    const telegramId = req.params.id;
    if (!telegramId) return res.status(400).json({ error: 'ID gerekli' });

    try {
        const userRef = db.ref(`users/${telegramId}`);
        const snapshot = await userRef.once('value');
        let userData = snapshot.val();

        if (!userData) {
            userData = { balance: 0, totalEarned: 0, refCount: 0, refEarned: 0, createdAt: admin.database.ServerValue.TIMESTAMP };
            await userRef.set(userData);
        }

        res.json({
            balance: userData.balance || 0,
            totalEarned: userData.totalEarned || 0,
            refCount: userData.refCount || 0,
            refEarned: userData.refEarned || 0
        });
    } catch (error) {
        res.status(500).json({ error: 'Veritabanı hatası' });
    }
});

app.post('/api/reward', async (req, res) => {
    const { telegramId } = req.body;
    if (!telegramId) return res.status(400).json({ error: 'ID eksik' });

    try {
        const userRef = db.ref(`users/${telegramId}`);
        await userRef.transaction((user) => {
            if (user) {
                user.balance = (user.balance || 0) + TARGET_REWARD;
                user.totalEarned = (user.totalEarned || 0) + TARGET_REWARD;
            } else {
                user = { balance: TARGET_REWARD, totalEarned: TARGET_REWARD, refCount: 0, refEarned: 0 };
            }
            return user;
        });

        const userSnap = await userRef.once('value');
        const userData = userSnap.val();

        if (userData && userData.inviter) {
            const inviterRef = db.ref(`users/${userData.inviter}`);
            const refRewardAmount = TARGET_REWARD * REF_PERCENTAGE;
            await inviterRef.transaction((inviter) => {
                if (inviter) {
                    inviter.balance = (inviter.balance || 0) + refRewardAmount;
                    inviter.refEarned = (inviter.refEarned || 0) + refRewardAmount;
                }
                return inviter;
            });
        }

        res.json({ success: true, reward: TARGET_REWARD });
    } catch (error) {
        res.status(500).json({ error: 'İşlem hatası' });
    }
});

app.post('/api/withdraw', async (req, res) => {
    const { telegramId, wallet, memo, amount } = req.body;
    if (!telegramId || !wallet || !amount || amount < 0.10) return res.status(400).json({ success: false });

    try {
        const userRef = db.ref(`users/${telegramId}`);
        let isSuccess = false;

        await userRef.transaction((user) => {
            if (user && user.balance >= amount) {
                user.balance -= amount;
                isSuccess = true;
                return user;
            }
            return; 
        });

        if (isSuccess) {
            await db.ref('withdraws').push().set({ telegramId, wallet, memo: memo || '', amount, status: 'pending', date: admin.database.ServerValue.TIMESTAMP });
            res.json({ success: true });
        } else {
            res.status(400).json({ success: false, error: 'Yetersiz bakiye' });
        }
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

app.get('/api/videos', async (req, res) => {
    try {
        const query = req.query.q || 'trending';
        const apiKey = process.env.YOUTUBE_API_KEY;
        const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=15&type=video&videoDuration=medium&key=${apiKey}&q=${encodeURIComponent(query)}`;
        const response = await axios.get(searchUrl);
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ error: 'API Hatası' });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Sunucu ${PORT} portunda çalışıyor...`));
