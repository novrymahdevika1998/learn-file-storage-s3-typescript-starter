import { respondWithJSON } from "./json";

import { type ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { getVideo, updateVideo } from "../db/videos";
import {
  BadRequestError,
  NotFoundError,
  UserForbiddenError,
  UserNotAuthenticatedError,
} from "./errors";
import { getBearerToken, validateJWT } from "../auth";
import { mediaTypeToExt } from "./assets";

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const { s3Client } = cfg;

  const { videoId } = req.params as { videoId?: string };

  if (!videoId) {
    throw new BadRequestError("videoId is required");
  }

  const video = await getVideo(cfg.db, videoId);
  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  if (!video) {
    throw new NotFoundError("Video not found");
  }

  if (video.userID !== userID) {
    throw new UserForbiddenError("You are not authorized to upload this video");
  }

  const formData = await req.formData();

  const file = formData.get("video");

  if (!(file instanceof File)) {
    return respondWithJSON(400, { error: "video is required" });
  }

  // Limit of 1 GB (1 << 30 bytes)
  if (file.size > 1 * 1024 * 1024 * 1024) {
    throw new BadRequestError("video is too large");
  }

  if (file.type !== "video/mp4") {
    throw new BadRequestError("video must be an MP4 file");
  }

  const ext = mediaTypeToExt(file.type);
  const key = `${videoId}${ext}`;
  const tmpPath = `/tmp/${key}`;
  let localFilePath: string | undefined;

  try {
    await Bun.write(tmpPath, file);
    localFilePath = await processVideoForFastStart(tmpPath);
    const localFile = Bun.file(localFilePath);

    
    const aspectRatio = await getVideoAspectRatio(tmpPath);
    const s3File = s3Client.file(`${aspectRatio}/${key}`, {
      type: file.type,
    });

    await Bun.write(s3File, localFile);

    video.videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${aspectRatio}/${key}`;

    await updateVideo(cfg.db, video);

    return respondWithJSON(200, { message: "video uploaded successfully" });
  } finally {
    await Bun.file(tmpPath).delete();
    await Bun.file(localFilePath as string).delete();
  }
}

export async function getVideoAspectRatio(filePath: string) {
  const proc = Bun.spawn(
    [
      "ffprobe",
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "json",
      "--",
      filePath,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const stdoutText = await new Response(proc.stdout).text();
  const stderrText = await new Response(proc.stderr).text();

  if ((await proc.exited) !== 0) {
    throw new Error(stderrText);
  }

  const result = JSON.parse(stdoutText);

  const ratio = result.streams[0].width / result.streams[0].height;

  // return string of landscape, portrait, or other
  if (ratio >= 1) {
    return "landscape";
  } else if (ratio < 1 && ratio >= 0) {
    return "portrait";
  } else {
    return "other";
  }
}

export async function processVideoForFastStart(inputFilePath: string) {  
  const outputFilePath = inputFilePath + ".processed.mp4"
  const proc = Bun.spawn([
    "ffmpeg",
    "-i",
    inputFilePath,
    "-movflags",
    "faststart",
    "-map_metadata",
    "0",
    "-codec",
    "copy",
    "-f",
    "mp4",
    outputFilePath,
  ], {
    stderr: "pipe",
  });

  const stderrText = await new Response(proc.stderr).text();

  if ((await proc.exited) !== 0) {
    throw new Error(stderrText);
  }

  return outputFilePath;
}
