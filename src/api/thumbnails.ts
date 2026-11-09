import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo, getVideos } from "../db/videos";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError } from "./errors";
import path from "path";
import { getAssetDiskPath, getAssetURL, mediaTypeToExt } from "./assets";
import { randomBytes } from "crypto";

const MAX_UPLOAD_SIZE = 10 * 1024 * 1024; // 10 MB

export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading thumbnail for video", videoId, "by user", userID);

  // TODO: implement the upload here
  const formData = await req.formData();

  const file = formData.get("thumbnail");
  if (!(file instanceof File)) {
    throw new BadRequestError("No thumbnail file provided");
  }

  if (file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("File too large");
  }

  const video = await getVideo(cfg.db, videoId)
  
  if (!video) {
    throw new NotFoundError("Video not found");
  }
  
  const ext = mediaTypeToExt(file.type)
  const filename = `${randomBytes(32).toString("base64url")}${ext}`;
  
  const assetDiskPath = getAssetDiskPath(cfg, filename);
  
  const mediaType = file.type;
  if (mediaType != "image/jpeg" && mediaType != "image/png") {
    throw new BadRequestError("Invalid file type");
  }
  
  await Bun.write(assetDiskPath, file);
  
  const urlPath = getAssetURL(cfg, filename)
  video.thumbnailURL = urlPath;
  
  await updateVideo(cfg.db, video);
  
  return respondWithJSON(200, video);
}
