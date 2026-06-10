import { initializeApp } from "firebase/app";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from "firebase/firestore";

// Firebase のウェブ設定（公開前提の値。安全性はFirestoreのルールで担保します）
const firebaseConfig = {
  apiKey: "AIzaSyDk6UeX7CmLi6j0PmXiwmV3EYjd4q33J5o",
  authDomain: "zaiko-f84cf.firebaseapp.com",
  projectId: "zaiko-f84cf",
  storageBucket: "zaiko-f84cf.firebasestorage.app",
  messagingSenderId: "984712626713",
  appId: "1:984712626713:web:a97579ef31420f7fcaa088",
};

export const firebaseReady = true;
const app = initializeApp(firebaseConfig);

// ・experimentalAutoDetectLongPolling: 端末やネットワークによる接続不良を自動回避
// ・persistentLocalCache: 端末内にキャッシュし、2回目以降の表示を高速化＋オフライン耐性
export const db = initializeFirestore(app, {
  experimentalAutoDetectLongPolling: true,
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});
