import { useState, useEffect } from 'react';
import { db } from '../lib/firebase';
import { collection, query, where, onSnapshot, orderBy, doc, getDoc, limit } from 'firebase/firestore';
import { Phone, Video, User as UserIcon, Clock, Calendar, ArrowLeft, PhoneIncoming, PhoneOutgoing, PhoneMissed } from 'lucide-react';
import { User as FirebaseUser } from 'firebase/auth';
import { CallSession, UserProfile } from '../types';
import { cn } from '../lib/utils';
import { format } from 'date-fns';
import { motion } from 'motion/react';
import { handleFirestoreError, OperationType } from '../lib/firestore-errors';

interface CallHistoryProps {
  currentUser: FirebaseUser;
  onBack: () => void;
}

export default function CallHistory({ currentUser, onBack }: CallHistoryProps) {
  const [calls, setCalls] = useState<CallSession[]>([]);
  const [userProfiles, setUserProfiles] = useState<Record<string, UserProfile>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Query calls where user is either caller or receiver
    const q1 = query(
      collection(db, 'calls'),
      where('callerId', '==', currentUser.uid),
      orderBy('createdAt', 'desc'),
      limit(50)
    );

    const q2 = query(
      collection(db, 'calls'),
      where('receiverId', '==', currentUser.uid),
      orderBy('createdAt', 'desc'),
      limit(50)
    );

    const handleSnapshot = async (snapshot: any) => {
      const newCalls = snapshot.docs.map((doc: any) => ({ id: doc.id, ...doc.data() } as CallSession));
      
      setCalls(prev => {
        const combined = [...prev, ...newCalls];
        // Sort by createdAt desc and remove duplicates
        const unique = Array.from(new Map(combined.map(c => [c.id, c])).values())
          .sort((a, b) => (b.createdAt?.toMillis() || 0) - (a.createdAt?.toMillis() || 0));
        return unique;
      });

      // Fetch user profiles for participants
      const uids = new Set<string>();
      newCalls.forEach((c: CallSession) => {
        if (c.callerId !== currentUser.uid) uids.add(c.callerId);
        if (c.receiverId !== currentUser.uid) uids.add(c.receiverId);
      });

      for (const uid of uids) {
        if (!userProfiles[uid]) {
          try {
            const userDoc = await getDoc(doc(db, 'users', uid));
            if (userDoc.exists()) {
              setUserProfiles(prev => ({ ...prev, [uid]: userDoc.data() as UserProfile }));
            }
          } catch (e) {
            handleFirestoreError(e, OperationType.GET, `users/${uid}`);
          }
        }
      }
      setLoading(false);
    };

    const unsubscribe1 = onSnapshot(q1, handleSnapshot, (e) => {
      handleFirestoreError(e, OperationType.LIST, 'calls');
    });

    const unsubscribe2 = onSnapshot(q2, handleSnapshot, (e) => {
      handleFirestoreError(e, OperationType.LIST, 'calls');
    });

    return () => {
      unsubscribe1();
      unsubscribe2();
    };
  }, [currentUser.uid]);

  const formatDuration = (seconds?: number) => {
    if (!seconds) return '00:00';
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="flex flex-col h-full bg-slate-950">
      <header className="p-5 bg-slate-900/80 backdrop-blur-xl border-b border-slate-800 flex items-center gap-4 shadow-2xl z-10">
        <button onClick={onBack} className="p-2.5 hover:bg-slate-800 rounded-2xl text-slate-400 transition-all active:scale-90">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div>
          <h2 className="text-xl font-bold text-slate-100">Call History</h2>
          <p className="text-[10px] text-indigo-400 uppercase tracking-widest font-bold">Secure Logs</p>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-4 space-y-3 custom-scrollbar">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-indigo-500"></div>
          </div>
        ) : calls.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center px-6">
            <div className="w-16 h-16 bg-slate-900 rounded-[2rem] flex items-center justify-center mb-4 border border-slate-800">
              <Clock className="w-8 h-8 text-slate-600" />
            </div>
            <p className="text-slate-400 font-medium">No call history yet.</p>
            <p className="text-xs text-slate-600 mt-1">Start a private session to make calls.</p>
          </div>
        ) : (
          calls.map((call) => {
            const isCaller = call.callerId === currentUser.uid;
            const otherId = isCaller ? call.receiverId : call.callerId;
            const otherUser = userProfiles[otherId];
            const isMissed = call.status === 'rejected' || (call.status === 'ringing' && !isCaller);

            return (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                key={call.id}
                className="bg-slate-900/50 border border-slate-800 p-4 rounded-3xl flex items-center gap-4 hover:bg-slate-900 transition-all group"
              >
                <div className="w-12 h-12 rounded-2xl bg-slate-800 flex items-center justify-center text-slate-500 group-hover:bg-slate-700 transition-colors">
                  <UserIcon className="w-6 h-6" />
                </div>
                
                <div className="flex-1 min-w-0">
                  <div className="flex justify-between items-start mb-1">
                    <span className="font-bold text-slate-100 truncate">
                      {otherUser?.nickname || 'Unknown User'}
                    </span>
                    <span className="text-[10px] font-bold text-slate-500 uppercase">
                      {call.createdAt ? format(call.createdAt.toDate(), 'MMM d, HH:mm') : ''}
                    </span>
                  </div>
                  
                  <div className="flex items-center gap-3">
                    <div className={cn(
                      "flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider",
                      isMissed ? "text-rose-500" : "text-emerald-500"
                    )}>
                      {isCaller ? (
                        <PhoneOutgoing className="w-3 h-3" />
                      ) : isMissed ? (
                        <PhoneMissed className="w-3 h-3" />
                      ) : (
                        <PhoneIncoming className="w-3 h-3" />
                      )}
                      {call.type} call
                    </div>
                    <span className="text-slate-700">•</span>
                    <div className="flex items-center gap-1.5 text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                      <Clock className="w-3 h-3" />
                      {formatDuration(call.duration)}
                    </div>
                  </div>
                </div>

                <div className="p-2.5 bg-indigo-500/10 rounded-2xl text-indigo-400 opacity-0 group-hover:opacity-100 transition-opacity">
                  {call.type === 'video' ? <Video className="w-4 h-4" /> : <Phone className="w-4 h-4" />}
                </div>
              </motion.div>
            );
          })
        )}
      </div>
    </div>
  );
}
