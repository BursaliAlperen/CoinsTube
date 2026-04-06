require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const admin = require('firebase-admin');

// Firebase Bağlantısı
// Aynı klasördeki serviceAccountKey.json dosyasını okur
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://shortstube-earn-default-rtdb.firebaseio.com" // Kendi database URL'ni kontrol et
});

const db = admin.database();
const app = express();
app.use(cors());
app.use(express.json());

// Frontend dosyalarını barındırmak için
app.use(express.static('public'));

// Sabit Değerler
const TARGET_REWARD = 0.005; // İzleme başı ödül
const REF_PERCENTAGE = 0.10; // Referanslardan %10 kazanç

// ==========================================
// 1. KULLANICI BİLGİLERİNİ GETİR
// ==========================================
app.get('/api/user/:id', async (req, res) => {
    const telegramId = req.params.id;
    if (!telegramId) return res.status(400).json({ error: 'ID gerekli' });

    try {
        const userRef = db.ref(`users/${telegramId}`);
        const snapshot = await userRef.once('value');
        let userData = snapshot.val();

        // Eğer kullanıcı veritabanında yoksa, sıfır değerlerle oluştur
        if (!userData) {
            userData = { 
                balance: 0, 
                totalEarned: 0, 
                refCount: 0, 
                refEarned: 0, 
                createdAt: admin.database.ServerValue.TIMESTAMP 
            };
            await userRef.set(userData);
        }

        res.json({
            balance: userData.balance || 0,
            totalEarned: userData.totalEarned || 0,
            refCount: userData.refCount || 0,
            refEarned: userData.refEarned || 0
        });
    } catch (error) {
        console.error("Kullanıcı verisi çekilemedi:", error);
        res.status(500).json({ error: 'Veritabanı hatası' });
    }
});

// ==========================================
// 2. VİDEO İZLEME ÖDÜLÜ EKLE (GÜVENLİ)
// ==========================================
app.post('/api/reward', async (req, res) => {
    const { telegramId } = req.body;
    if (!telegramId) return res.status(400).json({ error: 'Kullanıcı ID eksik' });

    try {
        const userRef = db.ref(`users/${telegramId}`);
        
        // TRANSACTION KULLANIMI: Hızlı tıklama/bug yapılarak çift bakiye alınmasını engeller
        await userRef.transaction((user) => {
            if (user) {
                user.balance = (user.balance || 0) + TARGET_REWARD;
                user.totalEarned = (user.totalEarned || 0) + TARGET_REWARD;
            } else {
                user = { balance: TARGET_REWARD, totalEarned: TARGET_REWARD, refCount: 0, refEarned: 0 };
            }
            return user;
        });

        // REFERANS KONTROLÜ VE ÖDÜLÜ:
        // Eğer bu kullanıcının bir davet edeni varsa, ona %10 (0.0005 TON) kazandır
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
        console.error("Ödül ekleme hatası:", error);
        res.status(500).json({ error: 'Ödül işlenemedi' });
    }
});

// ==========================================
// 3. PARA ÇEKME TALEBİ OLUŞTUR (GÜVENLİ)
// ==========================================
app.post('/api/withdraw', async (req, res) => {
    const { telegramId, wallet, memo, amount } = req.body;

    if (!telegramId || !wallet || !amount || amount < 0.10) {
        return res.status(400).json({ success: false, error: 'Geçersiz parametreler' });
    }

    try {
        const userRef = db.ref(`users/${telegramId}`);
        let isSuccess = false;

        // Transaction ile bakiye kontrolü (Eksiye düşmeyi tamamen engeller)
        await userRef.transaction((user) => {
            if (user && user.balance >= amount) {
                user.balance -= amount; // Bakiyeyi düş
                isSuccess = true;
                return user;
            }
            return; // Bakiye yetersizse işlemi iptal et
        });

        if (isSuccess) {
            // Çekim başarılı şekilde bakiyeden düşüldü, Withdraw tablosuna yaz
            const withdrawRef = db.ref('withdraws').push();
            await withdrawRef.set({
                telegramId: telegramId,
                wallet: wallet,
                memo: memo || '',
                amount: amount,
                status: 'pending', // Bekliyor
                date: admin.database.ServerValue.TIMESTAMP
            });

            res.json({ success: true });
        } else {
            res.status(400).json({ success: false, error: 'Yetersiz bakiye' });
        }
    } catch (error) {
        console.error("Çekim talebi hatası:", error);
        res.status(500).json({ success: false, error: 'İşlem başarısız' });
    }
});

// ==========================================
// 4. YOUTUBE API'DEN VİDEOLARI ÇEK
// ==========================================
app.get('/api/videos', async (req, res) => {
    try {
        const query = req.query.q || 'trending';
        const apiKey = process.env.YOUTUBE_API_KEY; // .env dosyasından çekilir
        
        const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=15&type=video&videoDuration=medium&key=${apiKey}&q=${encodeURIComponent(query)}`;
        const response = await axios.get(searchUrl);
        
        res.json(response.data);
    } catch (error) {
        console.error("Youtube API Hatası");
        res.status(500).json({ error: 'Video fetch error' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Backend ${PORT} portunda güvenli şekilde çalışıyor...`);
});
