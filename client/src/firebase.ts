import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getDatabase } from "firebase/database";

// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyBfGA1wF2-Ip9XdJCKF00_a-34lNNndGPg",
  authDomain: "peershare-3fbcb.firebaseapp.com",
  databaseURL: "https://peershare-3fbcb-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "peershare-3fbcb",
  storageBucket: "peershare-3fbcb.firebasestorage.app",
  messagingSenderId: "430998628757",
  appId: "1:430998628757:web:46d513a960d9d72cdaee9c",
  measurementId: "G-PBNPKB0Y4W"
};

const app = initializeApp(firebaseConfig);
export const database = getDatabase(app);
export const auth = getAuth(app);
