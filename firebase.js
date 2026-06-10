import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

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
export const db = getFirestore(app);
