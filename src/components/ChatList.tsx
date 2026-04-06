import { useState, useEffect, FormEvent, MouseEvent } from 'react';
import { db } from '../lib/firebase';
import { collection, query, where, onSnapshot, orderBy, getDocs, addDoc, serverTimestamp, doc, getDoc, deleteDoc, writeBatch } from 'firebase/firestore';
import { Search, User as UserIcon, Plus, Trash2 } from 'lucide-react';
import { User as FirebaseUser } from 'firebase/auth';
import { handleFirestoreError, OperationType } from '../lib/firestore-errors';
import { Conversation, UserProfile } from '../types';
import { cn } from '../lib/utils';
import { format } from 'date-fns';

interface ChatListProps {
  currentUser: FirebaseUser;
  onSelectChat: (chat: Conversation | null) => void;
  activeChatId?: string;
}

export default function ChatList({ currentUser, onSelectChat, activeChatId }: ChatListProps) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<UserProfile[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [otherUsers, setOtherUsers] = useState<Record<string, UserProfile>>({});

  useEffect(() => {
    const q = query(
      collection(db, 'conversations'),
      where('participants', 'array-contains', currentUser.uid),
      orderBy('updatedAt', 'desc')
    );

    const unsubscribe = onSnapshot(q, async (snapshot) => {
      const convs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Conversation));
      setConversations(convs);

      // Fetch user profiles for participants
      const uids = new Set<string>();
      convs.forEach(c => c.participants.forEach(p => {
        if (p !== currentUser.uid) uids.add(p);
      }));

      const newOtherUsers = { ...otherUsers };
      for (const uid of uids) {
        if (!newOtherUsers[uid]) {
          try {
            const userDoc = await getDoc(doc(db, 'users', uid));
            if (userDoc.exists()) {
              newOtherUsers[uid] = userDoc.data() as UserProfile;
            }
          } catch (e) {
            handleFirestoreError(e, OperationType.GET, `users/${uid}`);
          }
        }
      }
      setOtherUsers(newOtherUsers);
    }, (e) => {
      handleFirestoreError(e, OperationType.LIST, 'conversations');
    });

    return () => unsubscribe();
  }, [currentUser.uid]);

  const handleSearch = async (e: FormEvent) => {
    e.preventDefault();
    const term = searchQuery.trim();
    if (!term) return;

    setIsSearching(true);
    setSearchResults([]);
    try {
      // Search by IPCall ID (Exact)
      const ipcallQuery = query(
        collection(db, 'users'),
        where('ipcallId', '==', term)
      );
      
      // Search by Nickname (Prefix match, case-insensitive)
      const nicknameQuery = query(
        collection(db, 'users'),
        where('nickname_lowercase', '>=', term.toLowerCase()),
        where('nickname_lowercase', '<=', term.toLowerCase() + '\uf8ff')
      );

      const [ipcallSnap, nickSnap] = await Promise.all([
        getDocs(ipcallQuery),
        getDocs(nicknameQuery)
      ]);

      const resultsMap = new Map<string, UserProfile>();
      
      ipcallSnap.docs.forEach(doc => {
        const data = doc.data() as UserProfile;
        if (data.uid !== currentUser.uid) resultsMap.set(data.uid, data);
      });

      nickSnap.docs.forEach(doc => {
        const data = doc.data() as UserProfile;
        if (data.uid !== currentUser.uid) resultsMap.set(data.uid, data);
      });
      
      setSearchResults(Array.from(resultsMap.values()));
    } catch (e) {
      handleFirestoreError(e, OperationType.LIST, 'users');
    } finally {
      setIsSearching(false);
    }
  };

  const startConversation = async (otherUser: UserProfile) => {
    // Check if conversation already exists
    const existing = conversations.find(c => c.participants.includes(otherUser.uid));
    if (existing) {
      onSelectChat(existing);
      setSearchQuery('');
      setSearchResults([]);
      return;
    }

    // Create new conversation
    const newConv = {
      participants: [currentUser.uid, otherUser.uid],
      updatedAt: serverTimestamp(),
      lastMessage: 'Secure session started'
    };

    try {
      const docRef = await addDoc(collection(db, 'conversations'), newConv);
      onSelectChat({ id: docRef.id, ...newConv } as any);
      setSearchQuery('');
      setSearchResults([]);
    } catch (e) {
      handleFirestoreError(e, OperationType.CREATE, 'conversations');
    }
  };

  const deleteConversation = async (e: MouseEvent, convId: string) => {
    e.stopPropagation();
    if (!window.confirm('Are you sure you want to delete this conversation? This will remove it from your list.')) return;

    try {
      // Delete the conversation document
      await deleteDoc(doc(db, 'conversations', convId));
      
      // If it's the active chat, clear it
      if (activeChatId === convId) {
        onSelectChat(null);
      }

      // Also attempt to delete messages in this conversation
      const messagesQuery = query(collection(db, 'conversations', convId, 'messages'));
      const messagesSnap = await getDocs(messagesQuery);
      
      if (!messagesSnap.empty) {
        const batch = writeBatch(db);
        messagesSnap.docs.forEach(msgDoc => {
          batch.delete(msgDoc.ref);
        });
        await batch.commit();
      }
    } catch (e) {
      handleFirestoreError(e, OperationType.DELETE, `conversations/${convId}`);
    }
  };

  return (
    <div className="flex flex-col h-full overflow-hidden bg-slate-900">
      <div className="p-5">
        <form onSubmit={handleSearch} className="relative">
          <input 
            type="text" 
            placeholder="Search Nickname or IPCall ID" 
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              if (!e.target.value.trim()) {
                setSearchResults([]);
              }
            }}
            className="w-full bg-slate-800 border-slate-700 rounded-2xl py-3.5 pl-11 pr-12 focus:ring-2 focus:ring-indigo-500 transition-all text-sm text-white placeholder:text-slate-500"
          />
          <Search className="absolute left-4 top-3.5 w-4 h-4 text-slate-500" />
          {isSearching && (
            <div className="absolute right-4 top-3.5">
              <div className="animate-spin rounded-full h-4 w-4 border-t-2 border-indigo-500"></div>
            </div>
          )}
        </form>
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar">
        {searchQuery.trim() && !isSearching && searchResults.length === 0 && (
          <div className="px-5 py-4 text-center">
            <p className="text-xs text-slate-500 italic">No users found with "{searchQuery}"</p>
          </div>
        )}

        {searchResults.length > 0 && (
          <div className="px-5 mb-6">
            <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-3">Search Results</h3>
            {searchResults.map(user => (
              <button 
                key={user.uid}
                onClick={() => startConversation(user)}
                className="w-full flex items-center gap-4 p-4 bg-indigo-500/5 hover:bg-indigo-500/10 border border-indigo-500/10 rounded-2xl transition-all mb-2 group"
              >
                <div className="w-11 h-11 rounded-xl bg-indigo-500/20 flex items-center justify-center text-indigo-400">
                  <UserIcon className="w-6 h-6" />
                </div>
                <div className="text-left">
                  <div className="font-bold text-slate-100">{user.nickname}</div>
                  <div className="text-[10px] font-bold text-indigo-400 uppercase tracking-wider">{user.ipcallId}</div>
                </div>
                <Plus className="ml-auto w-5 h-5 text-indigo-500 group-hover:scale-110 transition-transform" />
              </button>
            ))}
          </div>
        )}

        <div className="px-3">
          <h3 className="px-4 text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-3">Private Sessions</h3>
          {conversations.length === 0 ? (
            <div className="text-center py-12 px-6">
              <div className="w-12 h-12 bg-slate-800 rounded-2xl flex items-center justify-center mx-auto mb-4">
                <Search className="w-6 h-6 text-slate-600" />
              </div>
              <p className="text-sm text-slate-500">No active sessions. Search for an IPCall ID to begin.</p>
            </div>
          ) : (
            conversations.map(conv => {
              const otherId = conv.participants.find(p => p !== currentUser.uid);
              const otherUser = otherId ? otherUsers[otherId] : null;

              return (
                <div key={conv.id} className="relative group">
                  <button 
                    onClick={() => onSelectChat(conv)}
                    className={cn(
                      "w-full flex items-center gap-4 p-4 rounded-2xl transition-all mb-1",
                      activeChatId === conv.id 
                        ? "bg-indigo-600/10 border border-indigo-600/20 shadow-lg shadow-indigo-600/5" 
                        : "hover:bg-slate-800/50 border border-transparent"
                    )}
                  >
                    <div className="relative">
                      <div className={cn(
                        "w-12 h-12 rounded-2xl flex items-center justify-center transition-colors",
                        activeChatId === conv.id ? "bg-indigo-500 text-white" : "bg-slate-800 text-slate-500"
                      )}>
                        <UserIcon className="w-6 h-6" />
                      </div>
                      {otherUser?.status === 'online' && (
                        <div className="absolute -bottom-1 -right-1 w-3.5 h-3.5 bg-emerald-500 border-2 border-slate-900 rounded-full"></div>
                      )}
                    </div>
                    <div className="flex-1 text-left overflow-hidden pr-8">
                      <div className="flex justify-between items-center mb-1">
                        <span className="font-bold text-slate-100 truncate">{otherUser?.nickname || 'Connecting...'}</span>
                        <span className="text-[10px] font-bold text-slate-500">
                          {conv.updatedAt ? format(conv.updatedAt.toDate(), 'HH:mm') : ''}
                        </span>
                      </div>
                      <p className="text-xs text-slate-500 truncate font-medium">{conv.lastMessage}</p>
                    </div>
                  </button>
                  <button 
                    onClick={(e) => deleteConversation(e, conv.id)}
                    className="absolute right-4 top-1/2 -translate-y-1/2 p-2 text-slate-600 hover:text-rose-500 opacity-0 group-hover:opacity-100 transition-all hover:bg-rose-500/10 rounded-xl"
                    title="Delete Session"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
