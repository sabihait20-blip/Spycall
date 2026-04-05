import { useEffect, useState } from 'react';
import { auth, db } from './lib/firebase';
import { onAuthStateChanged, signInWithPopup, GoogleAuthProvider, signOut } from 'firebase/auth';
import { doc, setDoc, serverTimestamp, onSnapshot, collection, query, where, getDocs, addDoc, updateDoc, orderBy, limit, getDocFromServer } from 'firebase/firestore';
import { useAuthState } from 'react-firebase-hooks/auth';
import { LogIn, LogOut, MessageSquare, Phone, Video, Search, Send, User as UserIcon, ArrowLeft, PhoneCall, PhoneOff, X, AlertCircle } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { format } from 'date-fns';
import { cn } from './lib/utils';
import { handleFirestoreError, OperationType } from './lib/firestore-errors';
import { UserProfile, Conversation, Message, CallSession } from './types';

// Components
import ChatList from './components/ChatList';
import ChatWindow from './components/ChatWindow';
import CallWindow from './components/CallWindow';

export default function App() {
  const [user, loading, error] = useAuthState(auth);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [activeChat, setActiveChat] = useState<Conversation | null>(null);
  const [incomingCall, setIncomingCall] = useState<CallSession | null>(null);
  const [activeCall, setActiveCall] = useState<CallSession | null>(null);
  const [showProfileSetup, setShowProfileSetup] = useState(false);
  const [nicknameInput, setNicknameInput] = useState('');
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  useEffect(() => {
    async function testConnection() {
      try {
        await getDocFromServer(doc(db, 'test', 'connection'));
      } catch (error) {
        if (error instanceof Error && error.message.includes('the client is offline')) {
          console.error("Please check your Firebase configuration. ");
          setConnectionError("Could not reach Firestore. Please check your internet or Firebase configuration.");
        }
      }
    }
    testConnection();
  }, []);

  useEffect(() => {
    if (user) {
      const userRef = doc(db, 'users', user.uid);
      const unsubscribeProfile = onSnapshot(userRef, (doc) => {
        if (doc.exists()) {
          const data = doc.data() as UserProfile;
          setUserProfile(data);
          setShowProfileSetup(false);
          // Update online status only if needed
          if (data.status !== 'online') {
            updateDoc(userRef, { status: 'online', lastSeen: serverTimestamp() }).catch(e => {
              handleFirestoreError(e, OperationType.UPDATE, `users/${user.uid}`);
            });
          }
        } else {
          setShowProfileSetup(true);
        }
      }, (e) => {
        handleFirestoreError(e, OperationType.GET, `users/${user.uid}`);
      });

      // Listen for incoming calls
      const incomingCallsQuery = query(
        collection(db, 'calls'),
        where('receiverId', '==', user.uid),
        where('status', '==', 'ringing')
      );

      const unsubscribeIncoming = onSnapshot(incomingCallsQuery, (snapshot) => {
        if (!snapshot.empty) {
          const callData = { id: snapshot.docs[0].id, ...snapshot.docs[0].data() } as CallSession;
          setIncomingCall(callData);
        } else {
          setIncomingCall(null);
        }
      }, (e) => {
        handleFirestoreError(e, OperationType.LIST, 'calls');
      });

      // Listen for calls where user is caller (to show outgoing call window)
      const outgoingCallsQuery = query(
        collection(db, 'calls'),
        where('callerId', '==', user.uid),
        where('status', 'in', ['ringing', 'accepted'])
      );

      const unsubscribeOutgoing = onSnapshot(outgoingCallsQuery, (snapshot) => {
        if (!snapshot.empty) {
          const callData = { id: snapshot.docs[0].id, ...snapshot.docs[0].data() } as CallSession;
          setActiveCall(callData);
        } else {
          setActiveCall(prev => prev?.callerId === user.uid ? null : prev);
        }
      }, (e) => {
        handleFirestoreError(e, OperationType.LIST, 'calls');
      });

      // Listen for accepted calls where user is receiver
      const acceptedIncomingQuery = query(
        collection(db, 'calls'),
        where('receiverId', '==', user.uid),
        where('status', '==', 'accepted')
      );

      const unsubscribeAccepted = onSnapshot(acceptedIncomingQuery, (snapshot) => {
        if (!snapshot.empty) {
          const callData = { id: snapshot.docs[0].id, ...snapshot.docs[0].data() } as CallSession;
          setActiveCall(callData);
        }
      }, (e) => {
        handleFirestoreError(e, OperationType.LIST, 'calls');
      });

      return () => {
        unsubscribeProfile();
        unsubscribeIncoming();
        unsubscribeOutgoing();
        unsubscribeAccepted();
      };
    }
  }, [user]);

  const handleLogin = async () => {
    if (isLoggingIn) return;
    setIsLoggingIn(true);
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (err: any) {
      if (err.code !== 'auth/cancelled-popup-request') {
        console.error('Login failed:', err);
      }
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleLogout = async () => {
    if (user) {
      const userRef = doc(db, 'users', user.uid);
      try {
        await updateDoc(userRef, { status: 'offline', lastSeen: serverTimestamp() });
      } catch (e) {
        console.warn('Logout status update failed', e);
      }
      signOut(auth);
      setUserProfile(null);
      setActiveChat(null);
    }
  };

  const handleSetupProfile = async () => {
    if (!user || !nicknameInput.trim()) return;
    
    const ipcallId = `IPCall-${Math.floor(1000 + Math.random() * 9000)}`;
    const userRef = doc(db, 'users', user.uid);
    
    try {
      await setDoc(userRef, {
        uid: user.uid,
        nickname: nicknameInput.trim(),
        nickname_lowercase: nicknameInput.trim().toLowerCase(),
        ipcallId: ipcallId,
        status: 'online',
        lastSeen: serverTimestamp(),
      });
    } catch (e) {
      handleFirestoreError(e, OperationType.CREATE, `users/${user.uid}`);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-slate-950">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-indigo-500"></div>
      </div>
    );
  }

  if (connectionError) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-slate-950 text-white p-4">
        <div className="bg-rose-500/10 border border-rose-500/20 p-8 rounded-[2.5rem] text-center max-w-md">
          <AlertCircle className="w-16 h-16 text-rose-500 mx-auto mb-4" />
          <h2 className="text-2xl font-bold mb-2">Connection Error</h2>
          <p className="text-slate-400 mb-6">{connectionError}</p>
          <button 
            onClick={() => window.location.reload()}
            className="bg-slate-800 hover:bg-slate-700 text-white px-6 py-3 rounded-2xl transition-all"
          >
            Retry Connection
          </button>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-slate-950 text-white p-4">
        <motion.div 
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          className="bg-slate-900 p-8 rounded-3xl border border-slate-800 shadow-2xl text-white flex flex-col items-center max-w-sm w-full"
        >
          <div className="bg-indigo-500/20 p-5 rounded-3xl mb-6">
            <PhoneCall className="w-12 h-12 text-indigo-400" />
          </div>
          <h1 className="text-3xl font-bold mb-2 tracking-tight">IPCallPrivate</h1>
          <p className="text-slate-400 text-center mb-8 text-sm">Secure, anonymous, and private communication.</p>
          <button 
            onClick={handleLogin}
            disabled={isLoggingIn}
            className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-800 disabled:text-slate-500 text-white font-semibold py-4 px-6 rounded-2xl transition-all flex items-center justify-center gap-3 shadow-lg shadow-indigo-600/20 active:scale-95"
          >
            {isLoggingIn ? (
              <div className="animate-spin rounded-full h-5 w-5 border-t-2 border-b-2 border-white"></div>
            ) : (
              <>
                <LogIn className="w-5 h-5" />
                Start Private Session
              </>
            )}
          </button>
        </motion.div>
      </div>
    );
  }

  if (showProfileSetup) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-slate-950 text-white p-4">
        <motion.div 
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          className="bg-slate-900 p-8 rounded-3xl border border-slate-800 shadow-2xl text-white flex flex-col items-center max-w-sm w-full"
        >
          <h2 className="text-2xl font-bold mb-2">Set Your Identity</h2>
          <p className="text-slate-400 text-center mb-8 text-sm">Choose a nickname. Your real identity will remain hidden.</p>
          
          <div className="w-full space-y-4">
            <input 
              type="text" 
              placeholder="Enter Nickname..." 
              value={nicknameInput}
              onChange={(e) => setNicknameInput(e.target.value)}
              className="w-full bg-slate-800 border-slate-700 rounded-2xl py-4 px-5 focus:ring-2 focus:ring-indigo-500 transition-all text-white placeholder:text-slate-500"
            />
            <button 
              onClick={handleSetupProfile}
              disabled={!nicknameInput.trim()}
              className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-800 disabled:text-slate-500 text-white font-semibold py-4 px-6 rounded-2xl transition-all flex items-center justify-center gap-3 active:scale-95"
            >
              Continue to App
            </button>
          </div>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-slate-950 overflow-hidden text-slate-200">
      {/* Sidebar */}
      <div className={cn(
        "w-full md:w-80 lg:w-96 bg-slate-900 border-r border-slate-800 flex flex-col h-full transition-all",
        activeChat ? "hidden md:flex" : "flex"
      )}>
        <header className="p-5 bg-slate-900/50 backdrop-blur-md border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-indigo-500/20 flex items-center justify-center text-indigo-400 border border-indigo-500/30">
              <UserIcon className="w-6 h-6" />
            </div>
            <div className="flex flex-col">
              <span className="font-bold text-slate-100 truncate max-w-[120px]">{userProfile?.nickname}</span>
              <span className="text-[10px] font-bold text-indigo-400 tracking-widest uppercase">{userProfile?.ipcallId}</span>
            </div>
          </div>
          <button onClick={handleLogout} className="p-2.5 hover:bg-slate-800 rounded-2xl text-slate-400 transition-all active:scale-90">
            <LogOut className="w-5 h-5" />
          </button>
        </header>

        <ChatList 
          currentUser={user} 
          onSelectChat={setActiveChat} 
          activeChatId={activeChat?.id} 
        />
      </div>

      {/* Main Content */}
      <div className={cn(
        "flex-1 flex flex-col h-full bg-slate-950",
        !activeChat ? "hidden md:flex items-center justify-center" : "flex"
      )}>
        {activeChat ? (
          <ChatWindow 
            conversation={activeChat} 
            currentUser={user} 
            onBack={() => setActiveChat(null)}
            onCall={(type) => {}}
          />
        ) : (
          <div className="text-center p-8 max-w-md">
            <div className="bg-indigo-500/10 p-8 rounded-[2.5rem] inline-block mb-6 border border-indigo-500/20">
              <PhoneCall className="w-20 h-20 text-indigo-500" />
            </div>
            <h2 className="text-3xl font-bold text-slate-100 mb-3">IPCallPrivate Secure</h2>
            <p className="text-slate-400 leading-relaxed">Your calls and messages are end-to-end encrypted. Search for an IPCall ID to start a private session.</p>
          </div>
        )}
      </div>

      {/* Incoming Call Overlay */}
      <AnimatePresence>
        {incomingCall && (
          <motion.div 
            initial={{ y: 100, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 100, opacity: 0 }}
            className="fixed bottom-8 left-1/2 -translate-x-1/2 bg-slate-900 shadow-2xl rounded-[2rem] p-8 border border-slate-800 flex flex-col items-center z-50 min-w-[320px]"
          >
            <div className="animate-pulse mb-6 bg-indigo-500/20 p-4 rounded-full">
              <PhoneCall className="w-12 h-12 text-indigo-400" />
            </div>
            <h3 className="text-xl font-bold text-slate-100 mb-1">Incoming {incomingCall.type} call</h3>
            <p className="text-slate-400 mb-8 text-sm">Secure connection requested...</p>
            <div className="flex gap-4 w-full">
              <button 
                onClick={async () => {
                  try {
                    await updateDoc(doc(db, 'calls', incomingCall.id), { status: 'accepted' });
                    setActiveCall(incomingCall);
                    setIncomingCall(null);
                  } catch (e) {
                    handleFirestoreError(e, OperationType.UPDATE, `calls/${incomingCall.id}`);
                  }
                }}
                className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-4 rounded-2xl flex items-center justify-center gap-2 transition-all active:scale-95"
              >
                <Phone className="w-5 h-5" />
                Accept
              </button>
              <button 
                onClick={async () => {
                  try {
                    await updateDoc(doc(db, 'calls', incomingCall.id), { status: 'rejected' });
                    setIncomingCall(null);
                  } catch (e) {
                    handleFirestoreError(e, OperationType.UPDATE, `calls/${incomingCall.id}`);
                  }
                }}
                className="flex-1 bg-rose-600/20 hover:bg-rose-600/30 text-rose-400 font-bold py-4 rounded-2xl flex items-center justify-center gap-2 transition-all active:scale-95 border border-rose-600/30"
              >
                <PhoneOff className="w-5 h-5" />
                Reject
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Active Call Window */}
      {activeCall && (
        <CallWindow 
          call={activeCall} 
          currentUser={user} 
          onEnd={() => setActiveCall(null)} 
        />
      )}
    </div>
  );
}
