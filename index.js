require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const admin = require('firebase-admin');

const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const TARGET_REWARD = 0.005; 
const REF_PERCENTAGE = 0.10; 
const ADMIN_ID = process.env.ADMIN_TG_ID;

// 1. KULLANICI GETİR
app.get('/api/user/:id', async (req, res) => {
    const telegramId = req.params.id;
    try {
        const userRef = db.collection('users').doc(telegramId);
        const doc = await userRef.get();
        let userData;
        if (!doc.exists) {
            userData = { balance: 0, totalEarned: 0, refCount: 0, refEarned: 0, createdAt: admin.firestore.FieldValue.serverTimestamp() };
            await userRef.set(userData);
        } else {
            userData = doc.data();
        }
        res.json({ ...userData, isAdmin: (telegramId === ADMIN_ID) });
    } catch (error) { res.status(500).json({ error: 'DB hatası' }); }
});

// 2. VİDEO ÖDÜLÜ
app.post('/api/reward', async (req, res) => {
    const { telegramId } = req.body;
    try {
        const userRef = db.collection('users').doc(telegramId);
        let userInviter = null;
        await db.runTransaction(async (t) => {
            const doc = await t.get(userRef);
            let newBalance = TARGET_REWARD, newTotal = TARGET_REWARD;
            if (doc.exists) {
                const data = doc.data();
                newBalance = (data.balance || 0) + TARGET_REWARD;
                newTotal = (data.totalEarned || 0) + TARGET_REWARD;
                userInviter = data.inviter || null;
            }
            t.set(userRef, { balance: newBalance, totalEarned: newTotal }, { merge: true });
        });
        if (userInviter) {
            const inviterRef = db.collection('users').doc(userInviter);
            const refAmt = TARGET_REWARD * REF_PERCENTAGE;
            await db.runTransaction(async (t) => {
                const doc = await t.get(inviterRef);
                if (doc.exists) t.update(inviterRef, { balance: (doc.data().balance || 0) + refAmt, refEarned: (doc.data().refEarned || 0) + refAmt });
            });
        }
        res.json({ success: true, reward: TARGET_REWARD });
    } catch (error) { res.status(500).json({ error: 'İşlem hatası' }); }
});

// 3. PARA ÇEKME (KULLANICI TALEBİ)
app.post('/api/withdraw', async (req, res) => {
    const { telegramId, wallet, amount } = req.body;
    if (!telegramId || !wallet || amount < 0.10) return res.status(400).json({ success: false });
    try {
        const userRef = db.collection('users').doc(telegramId);
        let isSuccess = false;
        await db.runTransaction(async (t) => {
            const doc = await t.get(userRef);
            if (doc.exists && doc.data().balance >= amount) {
                t.update(userRef, { balance: doc.data().balance - amount });
                isSuccess = true;
            }
        });
        if (isSuccess) {
            await db.collection('withdraws').add({ telegramId, wallet, amount, status: 'pending', date: admin.firestore.FieldValue.serverTimestamp() });
            res.json({ success: true });
        } else { res.status(400).json({ success: false, error: 'Yetersiz bakiye' }); }
    } catch (error) { res.status(500).json({ success: false }); }
});

// 4. KULLANICI ÇEKİM GEÇMİŞİ (YENİ EKLENDİ)
app.get('/api/withdraw/history/:id', async (req, res) => {
    try {
        const snapshot = await db.collection('withdraws').where('telegramId', '==', req.params.id).get();
        let history = [];
        snapshot.forEach(doc => history.push({ id: doc.id, ...doc.data() }));
        history.sort((a, b) => (b.date?.seconds || 0) - (a.date?.seconds || 0)); // Tarihe göre en yeni üstte
        res.json({ success: true, history });
    } catch (error) { res.status(500).json({ error: 'Geçmiş alınamadı' }); }
});

// 5. ADMİN: İSTATİSTİKLER (GÜNCELLENDİ)
app.get('/api/admin/stats', async (req, res) => {
    if (req.query.tgId !== ADMIN_ID) return res.status(403).json({ error: 'Yetkisiz!' });
    try {
        const pendingSnap = await db.collection('withdraws').where('status', '==', 'pending').get();
        let requests = []; pendingSnap.forEach(doc => requests.push({ id: doc.id, ...doc.data() }));

        const usersSnap = await db.collection('users').get(); // Tüm kullanıcı sayısı
        const totalUsers = usersSnap.size;

        const approvedSnap = await db.collection('withdraws').where('status', '==', 'approved').get();
        let totalPaid = 0; approvedSnap.forEach(doc => { totalPaid += Number(doc.data().amount || 0); });

        res.json({ success: true, pendingWithdrawsCount: requests.length, requests, totalUsers, totalPaid: totalPaid.toFixed(4) });
    } catch (error) { res.status(500).json({ error: 'Admin paneli hatası' }); }
});

// 6. ADMİN: ÇEKİM ONAY/RED İŞLEMİ (YENİ EKLENDİ - REDDEDİLİNCE İADE YAPAR)
app.post('/api/admin/withdraw/:id', async (req, res) => {
    const { tgId, status } = req.body;
    if (tgId !== ADMIN_ID) return res.status(403).json({ error: 'Yetkisiz!' });
    try {
        const wRef = db.collection('withdraws').doc(req.params.id);
        await db.runTransaction(async (t) => {
            const wDoc = await t.get(wRef);
            if (!wDoc.exists || wDoc.data().status !== 'pending') throw new Error('Geçersiz talep');
            t.update(wRef, { status });
            // Reddedilirse parayı iade et
            if (status === 'rejected') {
                const userRef = db.collection('users').doc(wDoc.data().telegramId);
                const userDoc = await t.get(userRef);
                if (userDoc.exists) t.update(userRef, { balance: (userDoc.data().balance || 0) + wDoc.data().amount });
            }
        });
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: 'İşlem hatası' }); }
});

// 7. YOUTUBE API
app.get('/api/videos', async (req, res) => {
    try {
        const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=15&type=video&key=${process.env.YOUTUBE_API_KEY}&q=${encodeURIComponent(req.query.q || 'trending')}`;
        res.json((await axios.get(url)).data);
    } catch (error) { res.status(500).json({ error: 'API Hatası' }); }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Sunucu ${PORT} portunda çalışıyor...`));
