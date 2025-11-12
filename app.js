const button = document.getElementById('getLocation');
const coordsDiv = document.getElementById('coords');

button.addEventListener('click', () => {
  if (!navigator.geolocation) {
    coordsDiv.textContent = 'Geolocation is not supported by your browser.';
    return;
  }

  coordsDiv.textContent = 'Locating...';
  button.disabled = true;

  navigator.geolocation.getCurrentPosition(
    (position) => {
      const { latitude, longitude, accuracy } = position.coords;
      coordsDiv.textContent = `
        Latitude: ${latitude.toFixed(6)}
        Longitude: ${longitude.toFixed(6)}
        Accuracy: ±${accuracy.toFixed(1)} meters
      `;
      button.disabled = false;
    },
    (error) => {
      coordsDiv.textContent = `Error: ${error.message}`;
      button.disabled = false;
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
  );
});
