import { useState, useEffect, useRef } from 'react';
import { db } from '../lib/firebase';
import { doc, onSnapshot, updateDoc, collection, addDoc, serverTimestamp, getDoc } from 'firebase/firestore';
import { PhoneOff, Mic, MicOff, Video, VideoOff, Volume2, VolumeX, User as UserIcon, Camera, Settings, MonitorUp, MonitorDown, MoreVertical } from 'lucide-react';
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
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user');
  const [videoQuality, setVideoQuality] = useState<'low' | 'medium' | 'high'>('medium');
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const pc = useRef<RTCPeerConnection | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const screenStream = useRef<MediaStream | null>(null);

  const signalingCleanup = useRef<(() => void) | null>(null);

  // ... (rest of the component logic remains the same)

  const toggleScreenShare = async () => {
    if (!isScreenSharing) {
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        screenStream.current = stream;
        const videoTrack = stream.getVideoTracks()[0];
        
        // Replace video track in peer connection
        const sender = pc.current?.getSenders().find(s => s.track?.kind === 'video');
        if (sender) {
          await sender.replaceTrack(videoTrack);
        }
        
        setIsScreenSharing(true);
        videoTrack.onended = () => toggleScreenShare();
      } catch (err) {
        console.error("Error starting screen share:", err);
      }
    } else {
      // Revert to camera
      const videoTrack = localStream?.getVideoTracks()[0];
      if (videoTrack) {
        const sender = pc.current?.getSenders().find(s => s.track?.kind === 'video');
        if (sender) {
          await sender.replaceTrack(videoTrack);
        }
      }
      screenStream.current?.getTracks().forEach(track => track.stop());
      setIsScreenSharing(false);
    }
  };

  // ... (rest of the component)

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

    const timer = setInterval(() => {
      setCallDuration(prev => prev + 1);
    }, 1000);

    setupWebRTC();

    return () => {
      unsubscribe();
      clearInterval(timer);
      cleanup();
      if (signalingCleanup.current) signalingCleanup.current();
    };
  }, [call.id]);

  const getConstraints = (mode: 'user' | 'environment', quality: 'low' | 'medium' | 'high') => {
    const qualityConstraints = {
      low: { width: { ideal: 320 }, height: { ideal: 240 } },
      medium: { width: { ideal: 640 }, height: { ideal: 480 } },
      high: { width: { ideal: 1280 }, height: { ideal: 720 } },
    };
    return {
      video: {
        facingMode: mode,
        ...qualityConstraints[quality]
      },
      audio: true
    };
  };

  const setupWebRTC = async (mode: 'user' | 'environment' = 'user', quality: 'low' | 'medium' | 'high' = 'medium') => {
    if (pc.current) {
      pc.current.close();
    }
    
    pc.current = new RTCPeerConnection(servers);

    const stream = await navigator.mediaDevices.getUserMedia(getConstraints(mode, quality));
    setLocalStream(stream);
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = stream;
    }

    stream.getTracks().forEach((track) => {
      pc.current?.addTrack(track, stream);
    });

    pc.current.ontrack = (event) => {
      setRemoteStream(event.streams[0]);
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
        if (pc.current && !pc.current.currentRemoteDescription && data?.offer) {
          await pc.current.setRemoteDescription(new RTCSessionDescription(data.offer));
          
          const answerDescription = await pc.current.createAnswer();
          await pc.current.setLocalDescription(answerDescription);

          await updateDoc(callDoc, { 
            answer: {
              type: answerDescription.type,
              sdp: answerDescription.sdp,
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
  
  // ... (rest of the component)

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
      <div className="relative w-full h-full flex items-center justify-center overflow-hidden bg-slate-950">
        {call.type === 'video' && remoteStream ? (
          <video 
            ref={remoteVideoRef} 
            autoPlay 
            playsInline 
            className="w-full h-full object-cover"
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

        {/* Local Video Picture-in-Picture */}
        {call.type === 'video' && (
          <motion.div 
            drag
            dragConstraints={{ left: -200, right: 200, top: -200, bottom: 200 }}
            className="absolute bottom-24 right-6 w-32 h-48 bg-slate-900 rounded-2xl border-2 border-white/20 shadow-2xl overflow-hidden cursor-grab active:cursor-grabbing z-20"
          >
            <video 
              ref={localVideoRef} 
              autoPlay 
              playsInline 
              muted 
              className="w-full h-full object-cover"
            />
            {isVideoOff && (
              <div className="absolute inset-0 bg-slate-900 flex items-center justify-center">
                <VideoOff className="w-8 h-8 text-slate-700" />
              </div>
            )}
          </motion.div>
        )}
      </div>

      {/* Controls */}
      <div className="absolute bottom-8 left-4 right-4 md:bottom-16 md:left-1/2 md:-translate-x-1/2 flex items-center justify-center gap-6 md:gap-8 bg-slate-900/90 backdrop-blur-2xl p-6 md:p-8 rounded-[2rem] md:rounded-[3rem] border border-white/10 shadow-2xl">
        <button 
          onClick={toggleMute}
          className={cn(
            "p-4 md:p-5 rounded-full transition-all active:scale-90",
            isMuted ? "bg-rose-500/20 text-rose-400" : "bg-white/10 text-white"
          )}
          title={isMuted ? "Unmute" : "Mute"}
        >
          {isMuted ? <MicOff className="w-6 h-6 md:w-7 md:h-7" /> : <Mic className="w-6 h-6 md:w-7 md:h-7" />}
        </button>

        {call.type === 'video' && (
          <button 
            onClick={toggleVideo}
            className={cn(
              "p-4 md:p-5 rounded-full transition-all active:scale-90",
              isVideoOff ? "bg-rose-500/20 text-rose-400" : "bg-white/10 text-white"
            )}
            title={isVideoOff ? "Turn Video On" : "Turn Video Off"}
          >
            {isVideoOff ? <VideoOff className="w-6 h-6 md:w-7 md:h-7" /> : <Video className="w-6 h-6 md:w-7 md:h-7" />}
          </button>
        )}

        <button 
          onClick={toggleLoudspeaker}
          className={cn(
            "p-4 md:p-5 rounded-full transition-all active:scale-90",
            !isLoudspeaker ? "bg-rose-500/20 text-rose-400" : "bg-white/10 text-white"
          )}
          title={isLoudspeaker ? "Switch to Earpiece" : "Switch to Loudspeaker"}
        >
          {isLoudspeaker ? <Volume2 className="w-6 h-6 md:w-7 md:h-7" /> : <VolumeX className="w-6 h-6 md:w-7 md:h-7" />}
        </button>

        <button 
          onClick={handleEndCall}
          className="p-5 md:p-6 bg-rose-600 hover:bg-rose-700 text-white rounded-full transition-all shadow-xl shadow-rose-600/20 active:scale-90"
          title="End Call"
        >
          <PhoneOff className="w-7 h-7 md:w-8 md:h-8" />
        </button>

        <button 
          onClick={() => {}} // Placeholder for menu
          className="p-4 md:p-5 rounded-full bg-white/10 text-white transition-all active:scale-90"
          title="More Options"
        >
          <MoreVertical className="w-6 h-6 md:w-7 md:h-7" />
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
