import { findByName, findByProps } from "@vendetta/metro";
import { React } from "@vendetta/metro/common";
import { after } from "@vendetta/patcher";
import { showToast } from "@vendetta/ui/toasts";
import { TouchableOpacity, Image } from "react-native";

// --- Discord Internal Metro Modules ---
const { getActivities } = findByProps("getActivities");
const UserStore = findByProps("getCurrentUser");
const MessageActions = findByProps("sendMessage", "receiveMessage");
const SelectedChannelStore = findByProps("getChannelId", "getVoiceChannelId");

let patches = [];

// --- Global State for the Background Loop ---
let isLive = false;
let syncInterval: any = null;
let currentLrcData: string | null = null;
let lastSentLyric = "";
let activeTrack = "";

// --- Lyrics API Integration ---
async function fetchLyrics(track: string, artist: string) {
    try {
        const res = await fetch(`https://lrclib.net/api/get?track_name=${encodeURIComponent(track)}&artist_name=${encodeURIComponent(artist)}`);
        if (!res.ok) return null;
        const data = await res.json();
        return data.syncedLyrics; 
    } catch (e) {
        return null;
    }
}

// --- LRC Parsing Logic ---
function getCurrentLyric(lrc: string, progressMs: number) {
    if (!lrc) return null;
    const lines = lrc.split('\n');
    let currentLine = null;
    
    for (const line of lines) {
        const match = line.match(/\[(\d+):(\d+\.\d+)\](.*)/);
        if (match) {
            const min = parseInt(match[1]);
            const sec = parseFloat(match[2]);
            const timeMs = (min * 60 + sec) * 1000;
            
            if (timeMs <= progressMs) {
                // Ignore empty lines to prevent spamming blank messages
                const text = match[3].trim();
                if (text) currentLine = text;
            } else {
                break;
            }
        }
    }
    return currentLine;
}

// --- Stop Function ---
function stopLiveLyrics() {
    isLive = false;
    if (syncInterval) clearInterval(syncInterval);
    syncInterval = null;
    currentLrcData = null;
    lastSentLyric = "";
    activeTrack = "";
    showToast("Live Lyrics stopped.");
}

// --- React Component for the Toggle Button ---
const LyricsToggleBtn = () => {
    // Local state to make the icon change color instantly
    const [active, setActive] = React.useState(isLive);

    const toggleLyrics = async () => {
        if (active) {
            setActive(false);
            stopLiveLyrics();
            return;
        }

        const currentUser = UserStore.getCurrentUser();
        if (!currentUser) return showToast("User not found");

        const activities = getActivities(currentUser.id);
        const spotify = activities?.find((a: any) => a.name === "Spotify" && a.type === 2);
        
        if (!spotify) return showToast("No Spotify activity detected!");

        const track = spotify.details;
        const artist = spotify.state;
        
        showToast(`Starting live lyrics for ${track}...`);
        setActive(true);
        isLive = true;
        activeTrack = track;
        
        const lyricsLrc = await fetchLyrics(track, artist);
        if (!lyricsLrc) {
            showToast("No synced lyrics found for this song.");
            setActive(false);
            stopLiveLyrics();
            return;
        }
        
        currentLrcData = lyricsLrc;

        // Start the background loop (checks every 1 second)
        syncInterval = setInterval(() => {
            const currentActivities = getActivities(currentUser.id);
            const currentSpotify = currentActivities?.find((a: any) => a.name === "Spotify" && a.type === 2);
            
            // Auto-stop if music stops or changes song
            if (!currentSpotify || currentSpotify.details !== activeTrack) {
                setActive(false);
                stopLiveLyrics();
                return;
            }

            const start = currentSpotify.timestamps?.start;
            if (!start) return;

            const progressMs = Date.now() - start;
            const currentLine = getCurrentLyric(currentLrcData!, progressMs);
            
            // If the line has changed, send it to chat!
            if (currentLine && currentLine !== lastSentLyric) {
                lastSentLyric = currentLine;
                const channelId = SelectedChannelStore.getChannelId();
                if (channelId) {
                    MessageActions.sendMessage(channelId, {
                        content: `🎤 *${currentLine}*`
                    });
                }
            }
        }, 1000);
    };

    return (
        <TouchableOpacity 
            key="spotify-lyrics-btn"
            style={{ marginHorizontal: 8, justifyContent: 'center' }}
            onPress={toggleLyrics}
        >
            <Image 
                source={{uri: "https://upload.wikimedia.org/wikipedia/commons/1/19/Spotify_logo_without_text.svg"}} 
                // Green when active, standard Discord gray when inactive
                style={{width: 22, height: 22, tintColor: active ? "#1DB954" : "#B5BAC1"}} 
            />
        </TouchableOpacity>
    );
};

export default {
    onLoad: () => {
        // --- UI Injection ---
        const Header = findByName("Header", false) || findByName("ChannelTitle", false);
        
        if (Header) {
            patches.push(after("default", Header, (args, res) => {
                const rightControls = res?.props?.right || res?.props?.children;
                
                if (Array.isArray(rightControls)) {
                    // Check if our button is already there to prevent duplicates on re-renders
                    const hasBtn = rightControls.some((child: any) => child?.key === "spotify-lyrics-btn");
                    if (!hasBtn) {
                        rightControls.unshift(<LyricsToggleBtn key="spotify-lyrics-btn" />);
                    }
                }
            }));
        }
    },
    onUnload: () => {
        // Cleanup UI and intervals on plugin disable
        stopLiveLyrics();
        for (const unpatch of patches) {
            unpatch();
        }
    }
}
