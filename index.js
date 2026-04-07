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

const TARGET_REWARD = 0.001; // 50 banner için verilecek ödül
const TARGET_ADS = 50;       // Kaç banner görülünce ödül verilecek
const REF_PERCENTAGE = 0.10; 
const ADMIN_ID = String(process.env.ADMIN_TG_ID);
const MIN_COOLDOWN_SECONDS = 20; 

const RENDER_URL = process.env.RENDER_EXTERNAL_URL || 'http://localhost:10000';
setInterval(() => { axios.get(`${RENDER_URL}/api/ping`).catch(() => {}); }, 14 * 60 * 1000);
app.get('/api/ping', (req, res) => res.send('pong'));

// 1. KULLANICI GETİR & REFERANS & CÜZDAN BİLGİSİ
app.get('/api/user/:id', async (req, res) => {
    const telegramId = String(req.params.id);
    const inviterId = req.query.ref ? String(req.query.ref) : null;

    try {
        const userRef = db.collection('users').doc(telegramId);
        const doc = await userRef.get();
        let userData;

        if (!doc.exists) {
            userData = { 
                balance: 0, totalEarned: 0, refCount: 0, refEarned: 0, 
                adImpressions: 0, 
                lastRewardTime: admin.firestore.Timestamp.fromMillis(0),
                wallet: "", memo: "", // Otomatik ödeme için kayıtlı cüzdan
                inviter: inviterId, createdAt: admin.firestore.FieldValue.serverTimestamp() 
            };
            await userRef.set(userData);

            if (inviterId && inviterId !== telegramId) {
                const invRef = db.collection('users').doc(inviterId);
                const invDoc = await invRef.get();
                if (invDoc.exists) await invRef.update({ refCount: admin.firestore.FieldValue.increment(1) });
            }
        } else {
            userData = doc.data();
        }
        
        res.json({ ...userData, isAdmin: (telegramId === ADMIN_ID), targetAds: TARGET_ADS });
    } catch (error) { res.status(500).json({ error: 'DB hatası' }); }
});

// 2. KULLANICI CÜZDAN BİLGİSİNİ KAYDETME
app.post('/api/user/wallet', async (req, res) => {
    const { telegramId, wallet, memo } = req.body;
    if (!telegramId || !wallet) return res.status(400).json({ success: false });

    try {
        const userRef = db.collection('users').doc(String(telegramId));
        await userRef.update({ wallet: wallet, memo: memo || "" });
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false }); }
});

// 3. REKLAM ÖDÜL SİSTEMİ
app.post('/api/reward', async (req, res) => {
    const { telegramId, reportedAds } = req.body;
    if (reportedAds < TARGET_ADS) return res.status(400).json({ success: false, error: 'Yetersiz gösterim.' });

    try {
        const userRef = db.collection('users').doc(String(telegramId));
        let userInviter = null;
        
        await db.runTransaction(async (t) => {
            const doc = await t.get(userRef);
            if (!doc.exists) throw new Error('user_not_found');

            const data = doc.data();
            const now = admin.firestore.Timestamp.now();
            const lastReward = data.lastRewardTime || admin.firestore.Timestamp.fromMillis(0);
            
            const secondsSinceLastReward = now.seconds - lastReward.seconds;
            if (secondsSinceLastReward < MIN_COOLDOWN_SECONDS) throw new Error('cooldown_active'); 

            let newBalance = (data.balance || 0) + TARGET_REWARD;
            let newTotal = (data.totalEarned || 0) + TARGET_REWARD;
            userInviter = data.inviter || null;

            t.set(userRef, { 
                balance: newBalance, 
                totalEarned: newTotal,
                adImpressions: (data.adImpressions || 0) + TARGET_ADS,
                lastRewardTime: now 
            }, { merge: true });
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
    } catch (error) { 
        if (error.message === 'cooldown_active') return res.status(429).json({ success: false });
        res.status(500).json({ success: false }); 
    }
});

// 4. OTOMATİK CUMA ÖDEMESİ (HER SAAT BAŞI KONTROL EDER)
setInterval(async () => {
    const today = new Date();
    // 5 = Cuma günü demektir.
    if (today.getDay() === 5) {
        try {
            const todayStr = today.toISOString().split('T')[0]; // YYYY-MM-DD
            const systemRef = db.collection('system').doc('autoPayouts');
            const sysDoc = await systemRef.get();
            const lastPayoutDate = sysDoc.exists ? sysDoc.data().lastDate : null;

            // Eğer bugün (bu Cuma) henüz ödeme dağıtılmadıysa dağıt!
            if (lastPayoutDate !== todayStr) {
                console.log("Cuma Otomatik Ödeme Sistemi Başladı...");
                
                const usersRef = db.collection('users');
                // Bakiyesi 0.10 ve üzeri olanları getir
                const snapshot = await usersRef.where('balance', '>=', 0.10).get();
                
                const batch = db.batch();
                let payoutCount = 0;

                snapshot.forEach(doc => {
                    const data = doc.data();
                    // Cüzdan adresi kayıtlıysa işleme al
                    if (data.wallet && data.wallet.length > 5) {
                        const amountToWithdraw = data.balance;
                        
                        // 1. Kullanıcı bakiyesini sıfırla
                        batch.update(doc.ref, { balance: 0 });
                        
                        // 2. Withdraws listesine "pending (bekleyen)" olarak ekle
                        const newWithdrawRef = db.collection('withdraws').doc();
                        batch.set(newWithdrawRef, {
                            telegramId: doc.id,
                            wallet: data.wallet,
                            memo: data.memo || '',
                            amount: amountToWithdraw,
                            status: 'pending',
                            date: admin.firestore.FieldValue.serverTimestamp(),
                            autoFriday: true // Otomatik olduğunu belirtmek için
                        });
                        payoutCount++;
                    }
                });

                // Toplu işlemi veritabanına kaydet
                await batch.commit();
                // Bu Cuma gününün işlendiğini sisteme not et
                await systemRef.set({ lastDate: todayStr });
                console.log(`${payoutCount} adet Cuma ödemesi sıraya alındı.`);
            }
        } catch (err) {
            console.error("Cuma ödemesi sırasında hata:", err);
        }
    }
}, 60 * 60 * 1000); // Saatte bir kontrol eder

// Referans ve Admin kısımları (Aynı)
app.get('/api/referrals/:id', async (req, res) => {
    try {
        const snap = await db.collection('users').where('inviter', '==', String(req.params.id)).get();
        let refs = [];
        snap.forEach(doc => {
            const idStr = doc.id;
            const hiddenId = idStr.length > 5 ? idStr.substring(0,3) + '***' + idStr.substring(idStr.length-3) : '***';
            refs.push({ id: hiddenId, date: doc.data().createdAt });
        });
        res.json({ success: true, referrals: refs });
    } catch (error) { res.status(500).json({ error: 'Hata' }); }
});

app.get('/api/withdraw/history/:id', async (req, res) => {
    try {
        const snapshot = await db.collection('withdraws').where('telegramId', '==', String(req.params.id)).get();
        let history = [];
        snapshot.forEach(doc => history.push({ id: doc.id, ...doc.data() }));
        history.sort((a, b) => (b.date?.seconds || 0) - (a.date?.seconds || 0)); 
        res.json({ success: true, history });
    } catch (error) { res.status(500).json({ error: 'Hata' }); }
});

app.get('/api/admin/stats', async (req, res) => {
    if (String(req.query.tgId) !== ADMIN_ID) return res.status(403).json({ error: 'Yetkisiz!' });
    try {
        const pendingSnap = await db.collection('withdraws').where('status', '==', 'pending').get();
        let requests = []; pendingSnap.forEach(doc => requests.push({ id: doc.id, ...doc.data() }));
        const usersSnap = await db.collection('users').orderBy('totalEarned', 'desc').limit(50).get();
        const totalUsers = (await db.collection('users').count().get()).data().count; 
        let usersList = []; usersSnap.forEach(doc => usersList.push({ id: doc.id, ...doc.data() }));
        const approvedSnap = await db.collection('withdraws').where('status', '==', 'approved').get();
        let totalPaid = 0; approvedSnap.forEach(doc => { totalPaid += Number(doc.data().amount || 0); });
        res.json({ success: true, pendingWithdrawsCount: requests.length, requests, totalUsers, totalPaid: totalPaid.toFixed(4), users: usersList });
    } catch (error) { res.status(500).json({ error: 'Hata' }); }
});

app.post('/api/admin/withdraw/:id', async (req, res) => {
    const { tgId, status } = req.body;
    if (String(tgId) !== ADMIN_ID) return res.status(403).json({ error: 'Yetkisiz!' });
    try {
        const wRef = db.collection('withdraws').doc(req.params.id);
        await db.runTransaction(async (t) => {
            const wDoc = await t.get(wRef);
            if (!wDoc.exists || wDoc.data().status !== 'pending') throw new Error('Hata');
            t.update(wRef, { status });
            if (status === 'rejected') {
                const userRef = db.collection('users').doc(wDoc.data().telegramId);
                const userDoc = await t.get(userRef);
                if (userDoc.exists) t.update(userRef, { balance: (userDoc.data().balance || 0) + wDoc.data().amount });
            }
        });
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: 'Hata' }); }
});

app.get('/api/videos', async (req, res) => {
    try {
        const keys = [ process.env.YOUTUBE_API_KEY, process.env.YOUTUBE_API_KEY_2, process.env.YOUTUBE_API_KEY_3 ].filter(Boolean);
        const query = encodeURIComponent(req.query.q || 'trending');
        const lang = req.query.lang || 'tr'; 
        
        let regionCode = 'US'; let relLang = 'en';
        if(lang === 'tr') { regionCode = 'TR'; relLang = 'tr'; }
        else if(lang === 'ru') { regionCode = 'RU'; relLang = 'ru'; }
        else if(lang === 'de') { regionCode = 'DE'; relLang = 'de'; }
        else if(lang === 'es') { regionCode = 'ES'; relLang = 'es'; }

        let items = []; let success = false; let workingApiKey = '';

        for (let apiKey of keys) {
            try {
                const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=20&type=video&order=viewCount&regionCode=${regionCode}&relevanceLanguage=${relLang}&key=${apiKey}&q=${query}`;
                const searchRes = await axios.get(searchUrl);
                items = searchRes.data.items || [];
                success = true; workingApiKey = apiKey;
                break; 
            } catch (err) {}
        }

        if (!success) return res.status(500).json({ error: 'API limitleri doldu!' });
        if (items.length === 0) return res.json({ items: [] });

        const videoIds = items.map(i => i.id.videoId).filter(Boolean).join(',');
        const channelIds = [...new Set(items.map(i => i.snippet.channelId))].filter(Boolean).join(',');

        let videoStats = {};
        if (videoIds) {
            const statsUrl = `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${videoIds}&key=${workingApiKey}`;
            const statsRes = await axios.get(statsUrl);
            (statsRes.data.items || []).forEach(v => { videoStats[v.id] = v.statistics?.viewCount || '0'; });
        }

        let channelAvatars = {};
        if (channelIds) {
            const channelsUrl = `https://www.googleapis.com/youtube/v3/channels?part=snippet&id=${channelIds}&key=${workingApiKey}`;
            const channelsRes = await axios.get(channelsUrl);
            (channelsRes.data.items || []).forEach(c => { channelAvatars[c.id] = c.snippet?.thumbnails?.default?.url || ''; });
        }

        const enrichedItems = items.map(item => {
            return {
                ...item,
                statistics: { viewCount: videoStats[item.id.videoId] || '0' },
                channelInfo: { avatar: channelAvatars[item.snippet.channelId] || `https://ui-avatars.com/api/?name=${encodeURIComponent(item.snippet.channelTitle)}&background=random` }
            };
        });

        res.json({ items: enrichedItems });
    } catch (error) { res.status(500).json({ error: 'Genel API Hatası' }); }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Sunucu ${PORT} portunda çalışıyor...`));
