import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getDatabase } from "firebase/database";

const firebaseConfig = {
  apiKey: "AIzaSyBfGA1wF2-Ip9XdJCKF00_a-34lNNndGpg",
  authDomain: "peershare-3fbcb.firebaseapp.com",
  databaseURL: "https://peershare-3fbcb-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "peershare-3fbcb",
  storageBucket: "peershare-3fbcb.firebasestorage.app",
  messagingSenderId: "430998628757",
  appId: "1:430998628757:web:af609889a72a42daee9c",
  measurementId: "G-9YMWZ8W35L",
};

const app = initializeApp(firebaseConfig);
export const database = getDatabase(app);
export const auth = getAuth(app);
