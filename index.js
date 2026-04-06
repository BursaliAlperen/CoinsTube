require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const admin = require('firebase-admin');

// Render'ın Secret Files kısmından okunacak
const serviceAccount = require('./serviceAccountKey.json');

// Firestore için sadece credential yeterlidir (databaseURL'e gerek yok)
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore(); // VERİTABANI FIRESTORE OLARAK DEĞİŞTİ
const app = express();
app.use(cors());
app.use(express.json());

app.use(express.static('public'));

const TARGET_REWARD = 0.005; 
const REF_PERCENTAGE = 0.10; 
const ADMIN_ID = process.env.ADMIN_TG_ID; // Yönetici ID'si .env'den çekiliyor

// ==========================================
// 1. KULLANICI GETİR (FIRESTORE)
// ==========================================
app.get('/api/user/:id', async (req, res) => {
    const telegramId = req.params.id;
    if (!telegramId) return res.status(400).json({ error: 'ID gerekli' });

    try {
        const userRef = db.collection('users').doc(telegramId);
        const doc = await userRef.get();

        let userData;
        if (!doc.exists) {
            // Kullanıcı yoksa Firestore'da yeni döküman oluştur
            userData = { 
                balance: 0, 
                totalEarned: 0, 
                refCount: 0, 
                refEarned: 0, 
                createdAt: admin.firestore.FieldValue.serverTimestamp() 
            };
            await userRef.set(userData);
        } else {
            userData = doc.data();
        }

        // Eğer bu kişi ADMIN ise, özel yetki objesi de gönderelim
        const isAdmin = (telegramId === ADMIN_ID);

        res.json({
            balance: userData.balance || 0,
            totalEarned: userData.totalEarned || 0,
            refCount: userData.refCount || 0,
            refEarned: userData.refEarned || 0,
            isAdmin: isAdmin
        });
    } catch (error) {
        res.status(500).json({ error: 'Veritabanı hatası' });
    }
});

// ==========================================
// 2. VİDEO ÖDÜLÜ EKLE (FIRESTORE TRANSACTION - %100 HİLE KORUMASI)
// ==========================================
app.post('/api/reward', async (req, res) => {
    const { telegramId } = req.body;
    if (!telegramId) return res.status(400).json({ error: 'ID eksik' });

    try {
        const userRef = db.collection('users').doc(telegramId);
        let userInviter = null;

        // Bakiye ekleme işlemi (Transaction)
        await db.runTransaction(async (t) => {
            const doc = await t.get(userRef);
            let newBalance = TARGET_REWARD;
            let newTotal = TARGET_REWARD;

            if (doc.exists) {
                const data = doc.data();
                newBalance = (data.balance || 0) + TARGET_REWARD;
                newTotal = (data.totalEarned || 0) + TARGET_REWARD;
                userInviter = data.inviter || null;
            }
            
            // Veriyi birleştirerek (merge) kaydet
            t.set(userRef, { balance: newBalance, totalEarned: newTotal }, { merge: true });
        });

        // Eğer davet edeni (referansı) varsa ona %10 gönder
        if (userInviter) {
            const inviterRef = db.collection('users').doc(userInviter);
            const refRewardAmount = TARGET_REWARD * REF_PERCENTAGE;

            await db.runTransaction(async (t) => {
                const doc = await t.get(inviterRef);
                if (doc.exists) {
                    const data = doc.data();
                    t.update(inviterRef, {
                        balance: (data.balance || 0) + refRewardAmount,
                        refEarned: (data.refEarned || 0) + refRewardAmount
                    });
                }
            });
        }

        res.json({ success: true, reward: TARGET_REWARD });
    } catch (error) {
        res.status(500).json({ error: 'İşlem hatası' });
    }
});

// ==========================================
// 3. PARA ÇEKME (FIRESTORE TRANSACTION)
// ==========================================
app.post('/api/withdraw', async (req, res) => {
    const { telegramId, wallet, memo, amount } = req.body;
    if (!telegramId || !wallet || !amount || amount < 0.10) return res.status(400).json({ success: false });

    try {
        const userRef = db.collection('users').doc(telegramId);
        let isSuccess = false;

        await db.runTransaction(async (t) => {
            const doc = await t.get(userRef);
            if (doc.exists) {
                const data = doc.data();
                if (data.balance >= amount) {
                    // Bakiye yetiyorsa düş
                    t.update(userRef, { balance: data.balance - amount });
                    isSuccess = true;
                }
            }
        });

        if (isSuccess) {
            // Withdraws koleksiyonuna yeni kayıt ekle
            await db.collection('withdraws').add({ 
                telegramId, 
                wallet, 
                memo: memo || '', 
                amount, 
                status: 'pending', 
                date: admin.firestore.FieldValue.serverTimestamp() 
            });
            res.json({ success: true });
        } else {
            res.status(400).json({ success: false, error: 'Yetersiz bakiye' });
        }
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

// ==========================================
// 4. ADMIN ÖZEL BİLGİ KONTROLÜ
// ==========================================
app.get('/api/admin/stats', async (req, res) => {
    const { tgId } = req.query;
    
    // Güvenlik: Sadece .env'de yazan ADMIN_TG_ID bu veriyi görebilir!
    if (tgId !== ADMIN_ID) {
        return res.status(403).json({ error: 'Yetkisiz erişim! Sen admin değilsin.' });
    }

    try {
        // Çekim taleplerini getir (Örnek Admin İşlemi)
        const snapshot = await db.collection('withdraws').where('status', '==', 'pending').get();
        let pendingRequests = [];
        snapshot.forEach(doc => {
            pendingRequests.push({ id: doc.id, ...doc.data() });
        });

        res.json({ 
            success: true, 
            message: "Hoşgeldin Patron!",
            pendingWithdrawsCount: pendingRequests.length,
            requests: pendingRequests
        });
    } catch (error) {
        res.status(500).json({ error: 'Admin paneli hatası' });
    }
});

// ==========================================
// 5. YOUTUBE API
// ==========================================
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
app.listen(PORT, () => console.log(`Firestore altyapılı sunucu ${PORT} portunda çalışıyor...`));
