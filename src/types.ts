import { Timestamp } from 'firebase/firestore';

export interface UserProfile {
  uid: string;
  nickname: string;
  echoId: string;
  status?: 'online' | 'offline';
  lastSeen?: Timestamp;
}

export interface Conversation {
  id: string;
  participants: string[];
  lastMessage?: string;
  updatedAt: Timestamp;
}

export interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  text: string;
  createdAt: Timestamp;
  type: 'text' | 'call';
}

export interface CallSession {
  id: string;
  callerId: string;
  receiverId: string;
  status: 'ringing' | 'accepted' | 'rejected' | 'ended';
  type: 'audio' | 'video';
  offer?: any;
  answer?: any;
}
