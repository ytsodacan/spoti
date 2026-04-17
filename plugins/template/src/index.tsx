import { findByName, findByProps } from "@vendetta/metro";
import { React, ReactNative } from "@vendetta/metro/common";
import { after } from "@vendetta/patcher";
import { showToast } from "@vendetta/ui/toasts";

const { TouchableOpacity, Image, View } = ReactNative;

// --- Discord Internal Metro Modules ---
const { getActivities } = findByProps("getActivities") || {};
const UserStore = findByProps("getCurrentUser");
const MessageActions = findByProps("sendMessage");
const SelectedChannelStore = findByProps("getChannelId");

let patches: (() => void)[] = [];

// --- Global State ---
let isLive = false;
let syncInterval: any = null;
let currentLrcData: string | null = null;
let lastSentLyric = "";
let activeTrack = "";

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
                const text = match[3].trim();
                if (text) currentLine = text;
            } else { break; }
        }
    }
    return currentLine;
}

function stopLiveLyrics() {
    isLive = false;
    if (syncInterval) clearInterval(syncInterval);
    syncInterval = null;
    currentLrcData = null;
    lastSentLyric = "";
    activeTrack = "";
}

const LyricsToggleBtn = () => {
    const [active, setActive] = React.useState(isLive);

    const toggleLyrics = async () => {
        if (active) {
            setActive(false);
            stopLiveLyrics();
            showToast("Lyrics sync stopped.");
            return;
        }

        const currentUser = UserStore?.getCurrentUser();
        if (!currentUser) return showToast("User not found");

        const activities = getActivities?.(currentUser.id);
        const spotify = activities?.find((a: any) => a.name === "Spotify" && a.type === 2);
        
        if (!spotify) return showToast("No Spotify activity detected!");

        const track = spotify.details;
        const artist = spotify.state;
        
        showToast(`Syncing: ${track}...`);
        setActive(true);
        isLive = true;
        activeTrack = track;
        
        const lyricsLrc = await fetchLyrics(track, artist);
        if (!lyricsLrc) {
            showToast("No synced lyrics found.");
            setActive(false);
            stopLiveLyrics();
            return;
        }
        
        currentLrcData = lyricsLrc;

        syncInterval = setInterval(() => {
            const currentActivities = getActivities?.(currentUser.id);
            const currentSpotify = currentActivities?.find((a: any) => a.name === "Spotify" && a.type === 2);
            
            if (!currentSpotify || currentSpotify.details !== activeTrack) {
                setActive(false);
                stopLiveLyrics();
                return;
            }

            const start = currentSpotify.timestamps?.start;
            if (!start) return;

            const progressMs = Date.now() - start;
            const currentLine = getCurrentLyric(currentLrcData!, progressMs);
            
            if (currentLine && currentLine !== lastSentLyric) {
                lastSentLyric = currentLine;
                const channelId = SelectedChannelStore?.getChannelId();
                if (channelId) {
                    MessageActions.sendMessage(channelId, { content: `🎤 *${currentLine}*` });
                }
            }
        }, 1000);
    };

    return (
        <TouchableOpacity 
            style={{ paddingHorizontal: 8, justifyContent: 'center', alignItems: 'center' }}
            onPress={toggleLyrics}
        >
            <Image 
                source={{ uri: "https://upload.wikimedia.org/wikipedia/commons/1/19/Spotify_logo_without_text.svg" }} 
                style={{ width: 20, height: 20, tintColor: active ? "#1DB954" : "#B5BAC1" }} 
            />
        </TouchableOpacity>
    );
};

export default {
    onLoad: () => {
        try {
            // Find the Chat Input component
            const ChatInput = findByName("ChatInput", false);
            
            if (!ChatInput) return console.error("[Spotify] ChatInput not found.");

            patches.push(after("render", ChatInput.prototype, (args, res) => {
                // Find the buttons container (usually holds Emoji, GIF, Gift)
                const buttons = res?.props?.children?.props?.children;
                
                if (Array.isArray(buttons)) {
                    // Look for the Nitro/Gift button index
                    // Discord usually identifies it via key or type
                    const giftIndex = buttons.findIndex((c: any) => 
                        c?.key === "gift" || 
                        c?.props?.type === "gift" || 
                        c?.type?.name === "GiftButton"
                    );

                    if (giftIndex !== -1) {
                        // Replace the Gift button with our Toggle
                        buttons[giftIndex] = <LyricsToggleBtn key="spotify-lyrics-btn" />;
                    } else {
                        // If no gift button found, just add it to the end of the button row
                        if (!buttons.some((c: any) => c?.key === "spotify-lyrics-btn")) {
                            buttons.push(<LyricsToggleBtn key="spotify-lyrics-btn" />);
                        }
                    }
                }
            }));

            showToast("Spotify Lyrics Ready!");
        } catch (err) {
            console.error("[Spotify] Load Error:", err);
        }
    },
    onUnload: () => {
        stopLiveLyrics();
        patches.forEach(unpatch => unpatch());
    }
};
