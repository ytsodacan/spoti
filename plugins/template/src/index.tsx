import { findByName, findByProps } from "@vendetta/metro";
import { React, ReactNative, toast } from "@vendetta/metro/common";
import { after } from "@vendetta/patcher";

const { TouchableOpacity, Image } = ReactNative;

// --- Discord Internal Metro Modules ---
const { getActivities } = findByProps("getActivities");
const UserStore = findByProps("getCurrentUser");
const MessageActions = findByProps("sendMessage");
const SelectedChannelStore = findByProps("getChannelId");

let patches: (() => void)[] = [];

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

// Helper function to safely dig through Discord's nested React structures
function findRightControls(res: any): any {
    if (!res) return null;
    if (res?.props?.right) return res.props.right;
    if (res?.props?.children?.props?.right) return res.props.children.props.right;
    
    // Sometimes it's buried in an array of children
    if (Array.isArray(res?.props?.children)) {
        for (const child of res.props.children) {
            if (child?.props?.right) return child.props.right;
        }
    }
    return null;
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
}

// --- React Component for the Toggle Button ---
const LyricsToggleBtn = () => {
    const [active, setActive] = React.useState(isLive);

    const toggleLyrics = async () => {
        if (active) {
            setActive(false);
            stopLiveLyrics();
            toast.show("Live Lyrics stopped.");
            return;
        }

        const currentUser = UserStore?.getCurrentUser();
        if (!currentUser) return toast.show("User not found");

        const activities = getActivities(currentUser.id);
        const spotify = activities?.find((a: any) => a.name === "Spotify" && a.type === 2);
        
        if (!spotify) return toast.show("No Spotify activity detected!");

        const track = spotify.details;
        const artist = spotify.state;
        
        toast.show(`Starting live lyrics for ${track}...`);
        setActive(true);
        isLive = true;
        activeTrack = track;
        
        const lyricsLrc = await fetchLyrics(track, artist);
        if (!lyricsLrc) {
            toast.show("No synced lyrics found.");
            setActive(false);
            stopLiveLyrics();
            return;
        }
        
        currentLrcData = lyricsLrc;

        syncInterval = setInterval(() => {
            const currentActivities = getActivities(currentUser.id);
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
            style={{ marginHorizontal: 12, justifyContent: 'center' }}
            onPress={toggleLyrics}
        >
            <Image 
                source={{ uri: "https://upload.wikimedia.org/wikipedia/commons/1/19/Spotify_logo_without_text.svg" }} 
                style={{ width: 22, height: 22, tintColor: active ? "#1DB954" : "#B5BAC1" }} 
            />
        </TouchableOpacity>
    );
};

export default {
    onLoad: () => {
        try {
            toast.show("[1] Spotify Loaded");

            // Strategy A: Find the standard React Navigation Header module
            const NavHeader = findByProps("Header", "Left", "Right");
            
            // Strategy B: Fallback to standalone Channel components
            const HeaderModule = findByName("Header", false) || findByName("ChannelTitle", false);

            if (!NavHeader && !HeaderModule) {
                toast.show("[X] Error: Could not find any header modules.");
                return;
            }

            toast.show("[2] Target Found");

            // Patch Strategy A (React Navigation Header)
            if (NavHeader && NavHeader.Header) {
                patches.push(after("Header", NavHeader, (args, res) => {
                    const rightControls = findRightControls(res);
                    if (Array.isArray(rightControls)) {
                        if (!rightControls.some((c: any) => c?.key === "spotify-lyrics-btn")) {
                            rightControls.unshift(<LyricsToggleBtn key="spotify-lyrics-btn" />);
                        }
                    }
                }));
            }

            // Patch Strategy B (Standard Discord Header)
            if (HeaderModule) {
                // Check if it's a module with a 'default' export, or just the function itself
                const targetObj = HeaderModule.default ? HeaderModule : null;
                const patchTarget = HeaderModule.default ? "default" : null;

                if (targetObj && patchTarget) {
                    patches.push(after(patchTarget, targetObj, (args, res) => {
                        const rightControls = findRightControls(res);
                        if (Array.isArray(rightControls)) {
                            if (!rightControls.some((c: any) => c?.key === "spotify-lyrics-btn")) {
                                rightControls.unshift(<LyricsToggleBtn key="spotify-lyrics-btn" />);
                            }
                        }
                    }));
                }
            }

        } catch (err) {
            toast.show(`[X] Load Error: ${err.message}`);
            console.error("[Spotify] Load Error:", err);
        }
    },
    onUnload: () => {
        stopLiveLyrics();
        for (const unpatch of patches) {
            unpatch();
        }
    }
};
