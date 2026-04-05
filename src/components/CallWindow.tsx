import { useState, useEffect, useRef } from 'react';
import { db } from '../lib/firebase';
import { doc, onSnapshot, updateDoc, collection, addDoc, serverTimestamp, getDoc, setDoc, deleteDoc, getDocs } from 'firebase/firestore';
import { PhoneOff, Mic, MicOff, Video, VideoOff, Volume2, VolumeX, User as UserIcon } from 'lucide-react';
import { User as FirebaseUser } from 'firebase/auth';
import { CallSession, UserProfile } from '../types';
import { cn } from '../lib/utils';
import { motion, AnimatePresence } from 'motion/react';
import { handleFirestoreError, OperationType } from '../lib/firestore-errors';

interface CallWindowProps {
  call: CallSession;
  currentUser: FirebaseUser;
  onEnd: () => void;
}

const servers = {
  iceServers: [
    {
      urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'],
    },
  ],
  iceCandidatePoolSize: 10,
};

export default function CallWindow({ call, currentUser, onEnd }: CallWindowProps) {
  const [otherUser, setOtherUser] = useState<UserProfile | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(call.type === 'audio');
  const [isLoudspeaker, setIsLoudspeaker] = useState(true);
  const [callDuration, setCallDuration] = useState(0);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const pc = useRef<RTCPeerConnection | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);

  const signalingCleanup = useRef<(() => void) | null>(null);

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
        cleanup();
        onEnd();
      }
    }, (e) => {
      handleFirestoreError(e, OperationType.GET, `calls/${call.id}`);
    });

    // Start timer
    const timer = setInterval(() => {
      setCallDuration(prev => prev + 1);
    }, 1000);

    // Initialize WebRTC
    setupWebRTC();

    return () => {
      unsubscribe();
      clearInterval(timer);
      cleanup();
      if (signalingCleanup.current) signalingCleanup.current();
    };
  }, [call.id]);

  const setupWebRTC = async () => {
    pc.current = new RTCPeerConnection(servers);

    // Get local media
    const stream = await navigator.mediaDevices.getUserMedia({
      video: call.type === 'video',
      audio: true
    });
    setLocalStream(stream);
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = stream;
    }

    // Push tracks from local stream to peer connection
    stream.getTracks().forEach((track) => {
      pc.current?.addTrack(track, stream);
    });

    // Pull tracks from remote stream, add to video stream
    pc.current.ontrack = (event) => {
      event.streams[0].getTracks().forEach((track) => {
        setRemoteStream(event.streams[0]);
      });
    };

    const callDoc = doc(db, 'calls', call.id);
    const callerCandidatesCollection = collection(callDoc, 'callerCandidates');
    const receiverCandidatesCollection = collection(callDoc, 'receiverCandidates');

    if (call.callerId === currentUser.uid) {
      // Caller logic
      pc.current.onicecandidate = (event) => {
        if (event.candidate) {
          addDoc(callerCandidatesCollection, event.candidate.toJSON());
        }
      };

      const offerDescription = await pc.current.createOffer();
      await pc.current.setLocalDescription(offerDescription);

      await updateDoc(callDoc, { 
        offer: {
          sdp: offerDescription.sdp,
          type: offerDescription.type,
        }
      });

      // Listen for remote answer
      const unsubscribeAnswer = onSnapshot(callDoc, (snapshot) => {
        const data = snapshot.data();
        if (!pc.current?.currentRemoteDescription && data?.answer) {
          const answerDescription = new RTCSessionDescription(data.answer);
          pc.current?.setRemoteDescription(answerDescription);
        }
      });

      // Listen for remote ICE candidates
      const unsubscribeCandidates = onSnapshot(receiverCandidatesCollection, (snapshot) => {
        snapshot.docChanges().forEach((change) => {
          if (change.type === 'added') {
            const data = change.doc.data();
            pc.current?.addIceCandidate(new RTCIceCandidate(data));
          }
        });
      });

      signalingCleanup.current = () => {
        unsubscribeAnswer();
        unsubscribeCandidates();
      };
    } else {
      // Receiver logic
      pc.current.onicecandidate = (event) => {
        if (event.candidate) {
          addDoc(receiverCandidatesCollection, event.candidate.toJSON());
        }
      };

      // Wait for offer if not present
      const unsubscribeOffer = onSnapshot(callDoc, async (snapshot) => {
        const data = snapshot.data();
        if (!pc.current?.currentRemoteDescription && data?.offer) {
          await pc.current?.setRemoteDescription(new RTCSessionDescription(data.offer));
          
          const answerDescription = await pc.current?.createAnswer();
          await pc.current?.setLocalDescription(answerDescription);

          await updateDoc(callDoc, { 
            answer: {
              type: answerDescription?.type,
              sdp: answerDescription?.sdp,
            }
          });
        }
      });

      // Listen for remote ICE candidates
      const unsubscribeCandidates = onSnapshot(callerCandidatesCollection, (snapshot) => {
        snapshot.docChanges().forEach((change) => {
          if (change.type === 'added') {
            const data = change.doc.data();
            pc.current?.addIceCandidate(new RTCIceCandidate(data));
          }
        });
      });

      signalingCleanup.current = () => {
        unsubscribeOffer();
        unsubscribeCandidates();
      };
    }
  };

  useEffect(() => {
    if (remoteVideoRef.current && remoteStream) {
      remoteVideoRef.current.srcObject = remoteStream;
    }
  }, [remoteStream]);

  const cleanup = () => {
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
    }
    if (pc.current) {
      pc.current.close();
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

  const toggleMute = () => {
    if (localStream) {
      localStream.getAudioTracks().forEach(track => {
        track.enabled = isMuted;
      });
      setIsMuted(!isMuted);
    }
  };

  const toggleVideo = () => {
    if (localStream) {
      localStream.getVideoTracks().forEach(track => {
        track.enabled = isVideoOff;
      });
      setIsVideoOff(!isVideoOff);
    }
  };

  const toggleLoudspeaker = () => {
    // In web browsers, we can't directly toggle "loudspeaker" mode like native apps.
    // However, we can toggle the volume or try to switch output devices if supported.
    // For now, we'll toggle a state and ensure the remote video element is at max volume.
    if (remoteVideoRef.current) {
      remoteVideoRef.current.volume = isLoudspeaker ? 0.2 : 1.0;
      setIsLoudspeaker(!isLoudspeaker);
    }
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
        {call.type === 'video' && remoteStream ? (
          <video 
            ref={remoteVideoRef} 
            autoPlay 
            playsInline 
            className="w-full h-full object-cover opacity-80"
          />
        ) : (
          <div className="flex flex-col items-center">
            <div className="w-40 h-40 rounded-[2.5rem] bg-slate-900 border border-indigo-500/30 flex items-center justify-center mb-8 shadow-2xl relative">
              <div className="absolute inset-0 bg-indigo-500/5 rounded-[2.5rem] animate-pulse"></div>
              <UserIcon className="w-20 h-20 text-indigo-400 relative z-10" />
              {/* Hidden audio for audio calls */}
              <video ref={remoteVideoRef} autoPlay playsInline className="hidden" />
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
      <div className="absolute bottom-16 left-1/2 -translate-x-1/2 flex items-center gap-4 md:gap-8 bg-slate-900/80 backdrop-blur-2xl p-6 md:p-8 rounded-[3rem] border border-white/5 shadow-2xl">
        <button 
          onClick={toggleMute}
          className={cn(
            "p-5 rounded-2xl transition-all active:scale-90 border",
            isMuted ? "bg-rose-500/20 border-rose-500/50 text-rose-400" : "bg-white/5 border-white/10 hover:bg-white/10 text-white"
          )}
          title={isMuted ? "Unmute" : "Mute"}
        >
          {isMuted ? <MicOff className="w-6 h-6" /> : <Mic className="w-6 h-6" />}
        </button>

        {call.type === 'video' && (
          <button 
            onClick={toggleVideo}
            className={cn(
              "p-5 rounded-2xl transition-all active:scale-90 border",
              isVideoOff ? "bg-rose-500/20 border-rose-500/50 text-rose-400" : "bg-white/5 border-white/10 hover:bg-white/10 text-white"
            )}
            title={isVideoOff ? "Turn Video On" : "Turn Video Off"}
          >
            {isVideoOff ? <VideoOff className="w-6 h-6" /> : <Video className="w-6 h-6" />}
          </button>
        )}

        <button 
          onClick={toggleLoudspeaker}
          className={cn(
            "p-5 rounded-2xl transition-all active:scale-90 border",
            !isLoudspeaker ? "bg-rose-500/20 border-rose-500/50 text-rose-400" : "bg-white/5 border-white/10 hover:bg-white/10 text-white"
          )}
          title={isLoudspeaker ? "Switch to Earpiece (Simulated)" : "Switch to Loudspeaker"}
        >
          {isLoudspeaker ? <Volume2 className="w-6 h-6" /> : <VolumeX className="w-6 h-6" />}
        </button>

        <button 
          onClick={handleEndCall}
          className="p-7 bg-rose-600 hover:bg-rose-700 text-white rounded-[2rem] transition-all shadow-xl shadow-rose-600/20 active:scale-90"
          title="End Call"
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
