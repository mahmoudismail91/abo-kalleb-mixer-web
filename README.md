# abo-kalleb-mixer-web
A simple browser-based ambient audio mixer built for live track swapping and loose soundscape layering.

abo-kalleb-mixer-webA simple browser-based ambient audio mixer built for live track swapping and loose soundscape layering.
i built this tool because i wanted something simple that enables me to drift out and listen to the sound recordings and data i've collected over the years.
i wanted a quick way to just hit next, next, or replace a track to hear random inputs from years of gathering sounds and samples.
at its core, this is a folder loader and random player. 
it randomly pulls and matches anywhere from 1 to 6 tracks together into a synchronized mix, and includes an ambient mode to keep the journey moving on its own. 

🎛️ featuresrandom layering combinations: every time you start a new mix, the tool randomizes how many tracks layer together, dynamically blending 1, 2, 3, 4, 5, or 6 channels at once based on probability. 

live track hot-swapping: click the 🔄 button next to any track slot to immediately swap in a fresh random file from your loaded library without breaking the active sync or stopping the playback. 

ambient drift module: switch on ambient mode to let the channels slowly shift their panning and volumes over time while automatically rotating new tracks into the mix on a custom timer. 

lossless wav exporter: hit record to capture your session directly from the master node buffer and download a clean .wav file with custom binary metadata header.

⚙️ how to run

since this is entirely client-side web audio code, you don't need any local compilers, servers, or software installations. just download and run the html file locally, or run it directly online:

run on itch.io: https://mahmoud-ismail.itch.io/al-hut-audio-mixer-abo-kalleb

run on my website: https://www.mah-mood.com

web tool (itch.io): https://mahmoud-ismail.itch.io/al-hut-audio-mixer-abo-kalleb

    audio archive & projects: https://www.mah-mood.com
