import { useState, useEffect, useRef, FormEvent } from 'react';
import { db, storage } from '../lib/firebase';
import { collection, query, where, onSnapshot, orderBy, addDoc, serverTimestamp, doc, getDoc, updateDoc } from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { Send, Phone, Video, ArrowLeft, User as UserIcon, MoreVertical, Mic, Square } from 'lucide-react';
import { User as FirebaseUser } from 'firebase/auth';
import { Conversation, Message, UserProfile } from '../types';
import { cn } from '../lib/utils';
import { format } from 'date-fns';
import { motion, AnimatePresence } from 'motion/react';

interface ChatWindowProps {
  conversation: Conversation;
  currentUser: FirebaseUser;
  onBack: () => void;
}

import { handleFirestoreError, OperationType } from '../lib/firestore-errors';

export default function ChatWindow({ conversation, currentUser, onBack }: ChatWindowProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [otherUser, setOtherUser] = useState<UserProfile | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [isRecording, setIsRecording] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    const otherId = conversation.participants.find(p => p !== currentUser.uid);
    if (otherId) {
      getDoc(doc(db, 'users', otherId)).then(doc => {
        if (doc.exists()) setOtherUser(doc.data() as UserProfile);
      }).catch(e => {
        handleFirestoreError(e, OperationType.GET, `users/${otherId}`);
      });
    }

    const q = query(
      collection(db, 'conversations', conversation.id, 'messages'),
      orderBy('createdAt', 'asc')
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      setMessages(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Message)));
    }, (e) => {
      handleFirestoreError(e, OperationType.LIST, `conversations/${conversation.id}/messages`);
    });

    return () => unsubscribe();
  }, [conversation.id, currentUser.uid]);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSendMessage = async (e: FormEvent) => {
    e.preventDefault();
    if (!newMessage.trim()) return;

    const messageData = {
      conversationId: conversation.id,
      senderId: currentUser.uid,
      text: newMessage.trim(),
      createdAt: serverTimestamp(),
      type: 'text'
    };

    const text = newMessage.trim();
    setNewMessage('');
    try {
      await addDoc(collection(db, 'conversations', conversation.id, 'messages'), messageData);
      await updateDoc(doc(db, 'conversations', conversation.id), {
        lastMessage: text,
        updatedAt: serverTimestamp()
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `conversations/${conversation.id}/messages`);
    }
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        audioChunksRef.current.push(event.data);
      };

      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/mp4' });
        const audioRef = ref(storage, `audio/${conversation.id}/${Date.now()}.mp4`);
        await uploadBytes(audioRef, audioBlob);
        const audioUrl = await getDownloadURL(audioRef);

        await addDoc(collection(db, 'conversations', conversation.id, 'messages'), {
          conversationId: conversation.id,
          senderId: currentUser.uid,
          audioUrl,
          createdAt: serverTimestamp(),
          type: 'audio'
        });
        
        await updateDoc(doc(db, 'conversations', conversation.id), {
          lastMessage: 'Voice message',
          updatedAt: serverTimestamp()
        });

        stream.getTracks().forEach(track => track.stop());
      };

      mediaRecorder.start();
      setIsRecording(true);
    } catch (err) {
      console.error("Error starting recording:", err);
    }
  };

  const stopRecording = () => {
    mediaRecorderRef.current?.stop();
    setIsRecording(false);
  };

  const startCall = async (type: 'audio' | 'video') => {
    if (!otherUser) return;

    const callData = {
      callerId: currentUser.uid,
      receiverId: otherUser.uid,
      status: 'ringing',
      type,
      createdAt: serverTimestamp()
    };

    try {
      await addDoc(collection(db, 'calls'), callData);
    } catch (e) {
      handleFirestoreError(e, OperationType.CREATE, 'calls');
    }
  };

  return (
    <div className="flex flex-col h-full bg-slate-950">
      <header className="p-5 bg-slate-900/80 backdrop-blur-xl border-b border-slate-800 flex items-center justify-between shadow-2xl z-10">
        <div className="flex items-center gap-4">
          <button onClick={onBack} className="md:hidden p-2.5 hover:bg-slate-800 rounded-2xl text-slate-400 transition-all">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="relative">
            <div className="w-11 h-11 rounded-2xl bg-indigo-500/20 flex items-center justify-center text-indigo-400 border border-indigo-500/30">
              <UserIcon className="w-6 h-6" />
            </div>
            {otherUser?.status === 'online' && (
              <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-emerald-500 border-2 border-slate-900 rounded-full"></div>
            )}
          </div>
          <div className="flex flex-col">
            <span className="font-bold text-slate-100 leading-tight">{otherUser?.nickname || 'Connecting...'}</span>
            <span className="text-[10px] text-indigo-400 uppercase tracking-widest font-bold">
              {otherUser?.ipcallId}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button 
            onClick={() => startCall('audio')}
            className="p-3 hover:bg-indigo-500/10 rounded-2xl text-indigo-400 transition-all active:scale-90 border border-transparent hover:border-indigo-500/20"
          >
            <Phone className="w-5 h-5" />
          </button>
          <button 
            onClick={() => startCall('video')}
            className="p-3 hover:bg-indigo-500/10 rounded-2xl text-indigo-400 transition-all active:scale-90 border border-transparent hover:border-indigo-500/20"
          >
            <Video className="w-5 h-5" />
          </button>
          <button className="p-3 hover:bg-slate-800 rounded-2xl text-slate-500 transition-all active:scale-90">
            <MoreVertical className="w-5 h-5" />
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-6 space-y-6 bg-slate-950 custom-scrollbar">
        {messages.map((msg, idx) => {
          const isMe = msg.senderId === currentUser.uid;
          const showTime = idx === 0 || 
            (msg.createdAt && messages[idx-1].createdAt && 
             msg.createdAt.toDate().getTime() - messages[idx-1].createdAt.toDate().getTime() > 300000);

          return (
            <div key={msg.id} className={cn("flex flex-col", isMe ? "items-end" : "items-start")}>
              {showTime && msg.createdAt && (
                <div className="w-full text-center my-6">
                  <span className="text-[10px] font-bold text-slate-500 uppercase tracking-[0.2em] bg-slate-900 px-3 py-1.5 rounded-full border border-slate-800">
                    {format(msg.createdAt.toDate(), 'MMM d, HH:mm')}
                  </span>
                </div>
              )}
              <motion.div 
                initial={{ scale: 0.95, opacity: 0, y: 10 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                className={cn(
                  "max-w-[80%] p-4 rounded-[1.5rem] text-sm shadow-xl leading-relaxed",
                  isMe 
                    ? "bg-indigo-600 text-white rounded-tr-none shadow-indigo-600/10" 
                    : "bg-slate-900 text-slate-200 border border-slate-800 rounded-tl-none"
                )}
              >
                {msg.type === 'audio' ? (
                  <audio controls src={msg.audioUrl} className="max-w-full" />
                ) : (
                  msg.text
                )}
              </motion.div>
            </div>
          );
        })}
        <div ref={scrollRef} />
      </div>

      <footer className="p-5 bg-slate-900/50 backdrop-blur-xl border-t border-slate-800">
        <form onSubmit={handleSendMessage} className="flex items-center gap-4">
          <input 
            type="text" 
            placeholder="Secure message..." 
            value={newMessage}
            onChange={(e) => setNewMessage(e.target.value)}
            className="flex-1 bg-slate-800 border-slate-700 rounded-2xl py-4 px-6 focus:ring-2 focus:ring-indigo-500 transition-all text-sm text-white placeholder:text-slate-500"
          />
          {isRecording ? (
            <button 
              type="button"
              onClick={stopRecording}
              className="bg-rose-600 hover:bg-rose-700 text-white p-4 rounded-2xl transition-all shadow-lg shadow-rose-600/20 active:scale-95"
            >
              <Square className="w-5 h-5" />
            </button>
          ) : (
            <button 
              type="button"
              onClick={startRecording}
              className="bg-slate-800 hover:bg-slate-700 text-slate-400 p-4 rounded-2xl transition-all active:scale-95"
            >
              <Mic className="w-5 h-5" />
            </button>
          )}
          <button 
            type="submit"
            disabled={!newMessage.trim() || isRecording}
            className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-800 disabled:text-slate-600 text-white p-4 rounded-2xl transition-all shadow-lg shadow-indigo-600/20 active:scale-95"
          >
            <Send className="w-5 h-5" />
          </button>
        </form>
      </footer>
    </div>
  );
}
