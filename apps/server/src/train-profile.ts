import { getDecisions, profileSignature, saveProfile, trainProfile } from "./style";

// Background child spawned by readStyleProfile. trainerLaunch pins its database path.
const username = process.argv[2];
if (!username) throw new Error("train-profile requires a username");

const signature = profileSignature(username);
const profile = trainProfile(username, getDecisions(username));
// Discard the result if analyses changed while this run was in flight.
if (profileSignature(username) === signature) saveProfile(profile, signature);
