import { useState, useEffect, useRef } from 'react';
import { db } from '../lib/firebase';
import { doc, onSnapshot, updateDoc, collection, addDoc, serverTimestamp, getDoc } from 'firebase/firestore';
import { PhoneOff, Mic, MicOff, Video, VideoOff, Maximize, Minimize, User as UserIcon } from 'lucide-react';
import { User as FirebaseUser } from 'firebase/auth';
import { CallSession, UserProfile } from '../types';
import { cn } from '../lib/utils';
import { motion, AnimatePresence } from 'motion/react';

interface CallWindowProps {
  call: CallSession;
  currentUser: FirebaseUser;
  onEnd: () => void;
}

import { handleFirestoreError, OperationType } from '../lib/firestore-errors';

export default function CallWindow({ call, currentUser, onEnd }: CallWindowProps) {
  const [otherUser, setOtherUser] = useState<UserProfile | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(call.type === 'audio');
  const [callDuration, setCallDuration] = useState(0);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);

  useEffect(() => {
    const otherId = call.callerId === currentUser.uid ? call.receiverId : call.callerId;
    getDoc(doc(db, 'users', otherId)).then(doc => {
      if (doc.exists()) setOtherUser(doc.data() as UserProfile);
    }).catch(e => {
      handleFirestoreError(e, OperationType.GET, `users/${otherId}`);
    });

    const unsubscribe = onSnapshot(doc(db, 'calls', call.id), (snapshot) => {
      const data = snapshot.data() as CallSession;
      if (data && (data.status === 'ended' || data.status === 'rejected')) {
        stopStreams();
        onEnd();
      }
    }, (e) => {
      handleFirestoreError(e, OperationType.GET, `calls/${call.id}`);
    });

    // Start timer
    const timer = setInterval(() => {
      setCallDuration(prev => prev + 1);
    }, 1000);

    // Initialize media
    startMedia();

    return () => {
      unsubscribe();
      clearInterval(timer);
      stopStreams();
    };
  }, [call.id]);

  const startMedia = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: call.type === 'video',
        audio: true
      });
      setLocalStream(stream);
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }
    } catch (err) {
      console.error('Error accessing media devices:', err);
    }
  };

  const stopStreams = () => {
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
    }
  };

  const handleEndCall = async () => {
    try {
      await updateDoc(doc(db, 'calls', call.id), { 
        status: 'ended',
        endedAt: serverTimestamp(),
        duration: callDuration
      });
    } catch (e) {
      handleFirestoreError(e, OperationType.UPDATE, `calls/${call.id}`);
    }
    onEnd();
  };

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[100] bg-slate-950 flex flex-col items-center justify-center text-white"
    >
      {/* Remote Video / Avatar */}
      <div className="relative w-full h-full flex items-center justify-center overflow-hidden">
        {call.type === 'video' && !isVideoOff ? (
          <video 
            ref={remoteVideoRef} 
            autoPlay 
            playsInline 
            className="w-full h-full object-cover opacity-40 grayscale" // Private aesthetic
          />
        ) : (
          <div className="flex flex-col items-center">
            <div className="w-40 h-40 rounded-[2.5rem] bg-slate-900 border border-indigo-500/30 flex items-center justify-center mb-8 shadow-2xl relative">
              <div className="absolute inset-0 bg-indigo-500/5 rounded-[2.5rem] animate-pulse"></div>
              <UserIcon className="w-20 h-20 text-indigo-400 relative z-10" />
            </div>
            <h2 className="text-3xl font-bold mb-2 tracking-tight">{otherUser?.nickname || 'Connecting...'}</h2>
            <p className="text-indigo-400 font-bold text-sm tracking-[0.3em] uppercase mb-4">{otherUser?.ipcallId}</p>
            <div className="bg-slate-900/50 backdrop-blur-md px-4 py-2 rounded-full border border-slate-800">
              <p className="text-slate-300 font-mono text-lg">{formatDuration(callDuration)}</p>
            </div>
          </div>
        )}

        {/* Local Video Preview */}
        {call.type === 'video' && (
          <div className="absolute top-10 right-10 w-48 h-64 bg-slate-900 rounded-3xl border border-white/10 shadow-2xl overflow-hidden">
            <video 
              ref={localVideoRef} 
              autoPlay 
              playsInline 
              muted 
              className="w-full h-full object-cover grayscale"
            />
            {isVideoOff && (
              <div className="absolute inset-0 bg-slate-900 flex items-center justify-center">
                <VideoOff className="w-8 h-8 text-slate-700" />
              </div>
            )}
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="absolute bottom-16 left-1/2 -translate-x-1/2 flex items-center gap-8 bg-slate-900/80 backdrop-blur-2xl p-8 rounded-[3rem] border border-white/5 shadow-2xl">
        <button 
          onClick={() => setIsMuted(!isMuted)}
          className={cn(
            "p-5 rounded-2xl transition-all active:scale-90 border",
            isMuted ? "bg-rose-500/20 border-rose-500/50 text-rose-400" : "bg-white/5 border-white/10 hover:bg-white/10 text-white"
          )}
        >
          {isMuted ? <MicOff className="w-6 h-6" /> : <Mic className="w-6 h-6" />}
        </button>

        {call.type === 'video' && (
          <button 
            onClick={() => setIsVideoOff(!isVideoOff)}
            className={cn(
              "p-5 rounded-2xl transition-all active:scale-90 border",
              isVideoOff ? "bg-rose-500/20 border-rose-500/50 text-rose-400" : "bg-white/5 border-white/10 hover:bg-white/10 text-white"
            )}
          >
            {isVideoOff ? <VideoOff className="w-6 h-6" /> : <Video className="w-6 h-6" />}
          </button>
        )}

        <button 
          onClick={handleEndCall}
          className="p-7 bg-rose-600 hover:bg-rose-700 text-white rounded-[2rem] transition-all shadow-xl shadow-rose-600/20 active:scale-90"
        >
          <PhoneOff className="w-8 h-8" />
        </button>
      </div>

      {/* Status Overlay */}
      <div className="absolute top-10 left-10 flex items-center gap-3 bg-slate-900/50 backdrop-blur-md px-5 py-2.5 rounded-2xl border border-white/5">
        <div className="w-2 h-2 bg-indigo-500 rounded-full animate-pulse shadow-[0_0_10px_rgba(99,102,241,0.8)]"></div>
        <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/70">Secure P2P Channel</span>
      </div>
    </motion.div>
  );
}
