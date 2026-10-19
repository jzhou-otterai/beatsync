import { z } from "zod";
import { CHAT_CONSTANTS, LOW_PASS_CONSTANTS } from "../constants";
import { LIVE_STREAM_CONSTANTS } from "../liveStream";
import { AudioSourceSchema, PositionSchema } from "./basic";

// ROOM EVENTS
export const LocationSchema = z.object({
  flagEmoji: z.string(),
  flagSvgURL: z.string(),
  city: z.string(),
  country: z.string(),
  region: z.string(),
  countryCode: z.string(),
});

export const ClientActionEnum = z.enum([
  "PLAY",
  "PAUSE",
  "NTP_REQUEST",
  "START_SPATIAL_AUDIO",
  "STOP_SPATIAL_AUDIO",
  "REORDER_CLIENT",
  "SET_LISTENING_SOURCE",
  "MOVE_CLIENT",
  "SYNC", // Client joins late, requests sync
  "SET_ADMIN", // Set admin status
  "SET_PLAYBACK_CONTROLS", // Set playback controls
  "SEND_IP", // Send IP to server
  "LOAD_DEFAULT_TRACKS", // Load default tracks into empty queue
  "DELETE_AUDIO_SOURCES", // Delete audio sources from the room queue (non-default only)
  "SEARCH_MUSIC", // Search for music
  "STREAM_MUSIC", // Stream music
  "SET_GLOBAL_VOLUME", // Set global volume for all clients
  "SEND_CHAT_MESSAGE", // Send a chat message,
  "AUDIO_SOURCE_LOADED", // Audio source loaded in response to a LOAD_AUDIO_SOURCE request
  "REORDER_AUDIO_SOURCES", // Reorder audio sources in the room queue
  "SET_METRONOME", // Toggle metronome on/off for all clients
  "SET_LOW_PASS_FREQ", // Set low-pass filter cutoff frequency
  "LIVENESS_PONG", // Liveness reply to a server LIVENESS_PING
  "START_LIVE_STREAM", // Become the room's live audio broadcaster (binary frames follow)
  "STOP_LIVE_STREAM", // Stop broadcasting live audio
  "CALIBRATION_CHIRP", // Live broadcaster: ask one listener to play a timing chirp
  "CALIBRATION_RESULT", // Live broadcaster: tell one listener how far off its chirp was
]);

export const NTPRequestPacketSchema = z.object({
  type: z.literal(ClientActionEnum.enum.NTP_REQUEST),
  t0: z.number(), // Client send timestamp
  t1: z.number().optional(), // Server receive timestamp (will be set by the server)
  clientRTT: z.number().optional(), // Client's current RTT estimate in ms
  clientCompensationMs: z.number().optional(), // Total local compensation (outputLatency + nudge) the client subtracts from wait time
  clientNudgeMs: z.number().optional(), // Manual timing nudge set by the user (persisted per-client)
  probeGroupId: z.number(), // Coded probes (Huygens): shared ID for both probes in a pair
  probeGroupIndex: z.union([z.literal(0), z.literal(1)]), // Coded probes: 0 = first probe, 1 = second probe
});

export const PlayActionSchema = z.object({
  type: z.literal(ClientActionEnum.enum.PLAY),
  trackTimeSeconds: z.number(),
  audioSource: z.string(),
});

export const PauseActionSchema = z.object({
  type: z.literal(ClientActionEnum.enum.PAUSE),
  audioSource: z.string(),
  trackTimeSeconds: z.number(),
});

const StartSpatialAudioSchema = z.object({
  type: z.literal(ClientActionEnum.enum.START_SPATIAL_AUDIO),
});

const StopSpatialAudioSchema = z.object({
  type: z.literal(ClientActionEnum.enum.STOP_SPATIAL_AUDIO),
});

const ReorderClientSchema = z.object({
  type: z.literal(ClientActionEnum.enum.REORDER_CLIENT),
  clientId: z.string(),
});

const SetListeningSourceSchema = z.object({
  type: z.literal(ClientActionEnum.enum.SET_LISTENING_SOURCE),
  x: z.number(),
  y: z.number(),
});

const MoveClientSchema = z.object({
  type: z.literal(ClientActionEnum.enum.MOVE_CLIENT),
  clientId: z.string(),
  position: PositionSchema,
});
export type MoveClientType = z.infer<typeof MoveClientSchema>;

const ClientRequestSyncSchema = z.object({
  type: z.literal(ClientActionEnum.enum.SYNC),
});
export type ClientRequestSyncType = z.infer<typeof ClientRequestSyncSchema>;

const LoadDefaultTracksSchema = z.object({
  type: z.literal(ClientActionEnum.enum.LOAD_DEFAULT_TRACKS),
});

const DeleteAudioSourcesSchema = z.object({
  type: z.literal(ClientActionEnum.enum.DELETE_AUDIO_SOURCES),
  urls: z.array(z.string()).min(1),
});

const SetAdminSchema = z.object({
  type: z.literal(ClientActionEnum.enum.SET_ADMIN),
  clientId: z.string(), // The client to set admin status for
  isAdmin: z.boolean(), // The new admin status
});

export const PlaybackControlsPermissionsEnum = z.enum(["ADMIN_ONLY", "EVERYONE"]);
export type PlaybackControlsPermissionsType = z.infer<typeof PlaybackControlsPermissionsEnum>;

export const SetPlaybackControlsSchema = z.object({
  type: z.literal(ClientActionEnum.enum.SET_PLAYBACK_CONTROLS),
  permissions: PlaybackControlsPermissionsEnum,
});

export const SendLocationSchema = z.object({
  type: z.literal(ClientActionEnum.enum.SEND_IP),
  location: LocationSchema,
});

export const SearchMusicSchema = z.object({
  type: z.literal(ClientActionEnum.enum.SEARCH_MUSIC),
  query: z.string(),
  offset: z.number().min(0).default(0).optional(),
});

export const StreamMusicSchema = z.object({
  type: z.literal(ClientActionEnum.enum.STREAM_MUSIC),
  trackId: z.number(),
  trackName: z.string().optional(),
});

export const SetGlobalVolumeSchema = z.object({
  type: z.literal(ClientActionEnum.enum.SET_GLOBAL_VOLUME),
  volume: z.number().min(0).max(1), // 0-1 range
});

export const SendChatMessageSchema = z.object({
  type: z.literal(ClientActionEnum.enum.SEND_CHAT_MESSAGE),
  text: z.string().max(CHAT_CONSTANTS.MAX_MESSAGE_LENGTH),
});

export const AudioSourceLoadedSchema = z.object({
  type: z.literal(ClientActionEnum.enum.AUDIO_SOURCE_LOADED),
  source: AudioSourceSchema,
});

export const ReorderAudioSourcesSchema = z.object({
  type: z.literal(ClientActionEnum.enum.REORDER_AUDIO_SOURCES),
  reorderedAudioSources: z.array(AudioSourceSchema).min(1),
});

export const SetMetronomeSchema = z.object({
  type: z.literal(ClientActionEnum.enum.SET_METRONOME),
  enabled: z.boolean(),
});

export const SetLowPassFreqSchema = z.object({
  type: z.literal(ClientActionEnum.enum.SET_LOW_PASS_FREQ),
  freq: z.number().min(LOW_PASS_CONSTANTS.MIN_FREQ).max(LOW_PASS_CONSTANTS.MAX_FREQ),
});

export const LivenessPongSchema = z.object({
  type: z.literal(ClientActionEnum.enum.LIVENESS_PONG),
});

export const StartLiveStreamSchema = z.object({
  type: z.literal(ClientActionEnum.enum.START_LIVE_STREAM),
  streamId: z.number().int().nonnegative(),
  sampleRate: z.number().int().min(8000).max(192000),
  channels: z.number().int().min(1).max(2),
  latencyMs: z.number().min(LIVE_STREAM_CONSTANTS.MIN_LATENCY_MS).max(LIVE_STREAM_CONSTANTS.MAX_LATENCY_MS),
  sourceName: z.string().max(100),
});

export const StopLiveStreamSchema = z.object({
  type: z.literal(ClientActionEnum.enum.STOP_LIVE_STREAM),
});

// Sent by the room's live broadcaster (the desktop app), which measures each listener's
// real timing with its microphone. See calibration.ts.
export const CalibrationChirpRequestSchema = z.object({
  type: z.literal(ClientActionEnum.enum.CALIBRATION_CHIRP),
  targetClientId: z.string(),
  chirpId: z.number().int().nonnegative(),
  playAtServerTime: z.number(),
});

export const CalibrationResultRequestSchema = z.object({
  type: z.literal(ClientActionEnum.enum.CALIBRATION_RESULT),
  targetClientId: z.string(),
  chirpId: z.number().int().nonnegative(),
  /** How late (+) or early (-) the listener's chirp was heard */
  correctionMs: z.number().min(-1000).max(1000),
});

export const WSRequestSchema = z.discriminatedUnion("type", [
  PlayActionSchema,
  PauseActionSchema,
  NTPRequestPacketSchema,
  StartSpatialAudioSchema,
  StopSpatialAudioSchema,
  ReorderClientSchema,
  SetListeningSourceSchema,
  MoveClientSchema,
  ClientRequestSyncSchema,
  SetAdminSchema,
  SetPlaybackControlsSchema,
  SendLocationSchema,
  LoadDefaultTracksSchema,
  DeleteAudioSourcesSchema,
  SearchMusicSchema,
  StreamMusicSchema,
  SetGlobalVolumeSchema,
  SendChatMessageSchema,
  AudioSourceLoadedSchema,
  ReorderAudioSourcesSchema,
  SetMetronomeSchema,
  SetLowPassFreqSchema,
  LivenessPongSchema,
  StartLiveStreamSchema,
  StopLiveStreamSchema,
  CalibrationChirpRequestSchema,
  CalibrationResultRequestSchema,
]);
export type WSRequestType = z.infer<typeof WSRequestSchema>;
export type PlayActionType = z.infer<typeof PlayActionSchema>;
export type PauseActionType = z.infer<typeof PauseActionSchema>;
export type ReorderClientType = z.infer<typeof ReorderClientSchema>;
export type SetListeningSourceType = z.infer<typeof SetListeningSourceSchema>;
export type ReorderAudioSourcesType = z.infer<typeof ReorderAudioSourcesSchema>;

// Mapped type to access request types by their type field
export type ExtractWSRequestFrom = {
  [K in WSRequestType["type"]]: Extract<WSRequestType, { type: K }>;
};
